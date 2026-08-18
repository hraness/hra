import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import type { ChatPaneProjection } from "../../contracts/runtime";
import { reduceRuntimeProjectionEvent } from "../../contracts/runtime-projection";
import { emptyRuntimeSnapshot } from "../../frontend/src/runtime/test-fixtures";
import {
  CHAT_MAX_DELTA_UTF8_BYTES,
  ChatProviderEffectError,
  ChatService,
  type ChatServiceOptions,
  type ChatAccountCandidate,
  type ChatAccountPort,
  type ChatHarnessActorTurnPort,
  type ChatHarnessRootPort,
  type ChatHistoryItem,
  type ChatProjectionSink,
  type ChatProviderConfiguration,
  type ChatProviderPort,
  type ChatProviderResumeRequest,
  type ChatProviderThreadRequest,
  type ChatProviderTurnRequest,
  type ChatRuntimeRecoveryPort,
  type ChatThreadBinding,
  type ChatTurnDelta,
  type ChatWorkspacePort,
} from "../src/chat";
import type {
  SessionAssistantItemCompletion,
  SessionInteractionRequest,
  SessionReasoningItemCompletion,
  SessionToolItemStarted,
  SessionTurnActivity,
  SessionTurnLifecycle,
} from "../src/sessions/session-service";
import { applyMigrations } from "../src/state/database";
import {
  ChatPaneStore,
} from "../src/state/chat-pane-store";
import { RootTurnRoutingSQLiteAuthorityV1 } from "../src/harness/root-turn-routing-sqlite-v1";
import type { RootTurnRoutingAuthorityV1 } from "../src/harness/root-turn-routing-sqlite-v1";

const ACCOUNT_ONE = "acct_chatprimary1";
const ACCOUNT_TWO = "acct_chatsecond01";
const ACCOUNT_THREE = "acct_chatthird001";
const PANE = "pane_chatprimary1";
const PANE_TWO = "pane_chatsecond01";
const PANE_THREE = "pane_chatthird001";
const REPOSITORY = `repo_${"0".repeat(26)}`;
const REPOSITORY_TWO = `repo_${"1".repeat(26)}`;
const TURN_ONE = "chatturn_primary01";
const TURN_TWO = "chatturn_primary02";
const ASSISTANT_ITEM = "item_chatassistant01";

interface StartedTurn {
  readonly request: ChatProviderTurnRequest;
  readonly turnId: string;
}

class FakeProvider implements ChatProviderPort {
  readonly injected: Array<Readonly<{
    binding: ChatThreadBinding;
    history: readonly ChatHistoryItem[];
  }>> = [];
  readonly interrupts: Array<ChatThreadBinding & Readonly<{ turnId: string }>> = [];
  readonly resumedThreads: ChatProviderResumeRequest[] = [];
  readonly startedThreads: ChatProviderThreadRequest[] = [];
  readonly startedTurns: StartedTurn[] = [];
  readonly steeredTurns: Parameters<ChatProviderPort["steerTurn"]>[0][] = [];
  readonly names: Array<Readonly<{ binding: ChatThreadBinding; name: string }>> = [];
  readonly validations: Array<Readonly<{
    accountProfileId: string;
    model: "gpt-5.6-sol" | "gpt-5.6-luna";
    reasoningEffort: "ultra" | "max";
    serviceTier: "standard" | "fast";
  }>> = [];
  readonly resolutionCandidates: ChatProviderConfiguration[][] = [];
  events: string[] | null = null;
  onInterrupt: (() => Promise<void>) | null = null;
  onResolveConfiguration: ChatProviderPort["resolveConfiguration"] | null = null;
  onStartThread: ((request: ChatProviderThreadRequest) => Promise<Readonly<{
    threadId: string;
    restartThreadId: string;
  }>>) | null = null;
  onStartTurn: ((request: ChatProviderTurnRequest) => Promise<string>) | null = null;
  onSteerTurn: (
    (request: Parameters<ChatProviderPort["steerTurn"]>[0]) => Promise<void>
  ) | null = null;
  #threadSequence = 0;
  #turnSequence = 0;

  async resolveConfiguration(
    accountProfileId: string,
    candidates: readonly ChatProviderConfiguration[],
  ): Promise<ChatProviderConfiguration> {
    this.resolutionCandidates.push([...candidates]);
    const selected = this.onResolveConfiguration === null
      ? candidates[0]
      : await this.onResolveConfiguration(accountProfileId, candidates);
    if (selected === undefined) throw new Error("Expected one routing candidate");
    this.validations.push({
      accountProfileId,
      model: selected.model,
      reasoningEffort: selected.reasoningEffort,
      serviceTier: selected.serviceTier ?? "standard",
    });
    this.events?.push(
      `provider.resolve:${selected.model}:${selected.reasoningEffort}:${selected.serviceTier ?? "standard"}`,
    );
    return selected;
  }

  async startThread(request: ChatProviderThreadRequest): Promise<Readonly<{
    threadId: string;
    restartThreadId: string;
  }>> {
    this.events?.push("provider.startThread");
    this.startedThreads.push(request);
    if (this.onStartThread !== null) return await this.onStartThread(request);
    this.#threadSequence += 1;
    const sequence = String(this.#threadSequence);
    const started = {
      threadId: `thread_chat_${sequence}`,
      restartThreadId: `raw_thread_chat_${sequence}`,
    };
    this.events?.push("provider.startThread.accepted");
    return Promise.resolve(started);
  }

  resumeThread(request: ChatProviderResumeRequest): Promise<void> {
    this.events?.push("provider.resumeThread");
    this.resumedThreads.push(request);
    return Promise.resolve();
  }

  setThreadName(binding: ChatThreadBinding, name: string): Promise<void> {
    this.names.push({ binding, name });
    return Promise.resolve();
  }

  injectHistory(binding: ChatThreadBinding, history: readonly ChatHistoryItem[]): Promise<void> {
    this.events?.push("provider.injectHistory");
    this.injected.push({ binding, history });
    return Promise.resolve();
  }

  async startTurn(request: ChatProviderTurnRequest): Promise<Readonly<{
    turnId: string;
    quotaProofCursor: Readonly<{ generation: number; streamPosition: number }>;
  }>> {
    this.events?.push("provider.startTurn");
    this.#turnSequence += 1;
    const turnId = this.onStartTurn === null
      ? `turn_chat_${String(this.#turnSequence)}`
      : await this.onStartTurn(request);
    this.startedTurns.push({ request, turnId });
    this.events?.push("provider.startTurn.accepted");
    return {
      turnId,
      quotaProofCursor: { generation: 1, streamPosition: this.#turnSequence },
    };
  }

  interruptTurn(input: ChatThreadBinding & Readonly<{ turnId: string }>): Promise<void> {
    this.interrupts.push(input);
    return this.onInterrupt?.() ?? Promise.resolve();
  }

  verifySteerTarget(): ReturnType<ChatProviderPort["verifySteerTarget"]> {
    return { generation: 1 };
  }

  steerTurn(
    request: Parameters<ChatProviderPort["steerTurn"]>[0],
  ): ReturnType<ChatProviderPort["steerTurn"]> {
    this.steeredTurns.push(structuredClone(request));
    return this.onSteerTurn?.(request) ?? Promise.resolve();
  }
}

class FakeHarnessRoots implements ChatHarnessRootPort {
  readonly admissions: Parameters<ChatHarnessRootPort["admit"]>[0][] = [];
  readonly observations: Parameters<ChatHarnessRootPort["observe"]>[0][] = [];
  readonly settlements: Parameters<ChatHarnessRootPort["settleBeforeProvider"]>[0][] = [];
  onAdmit: (() => void | Promise<void>) | null = null;
  onObserve: (() => void | Promise<void>) | null = null;
  onSettle: (() => void | Promise<void>) | null = null;

  async admit(
    input: Parameters<ChatHarnessRootPort["admit"]>[0],
  ): Promise<Readonly<{ turnId: string }>> {
    this.admissions.push(input);
    await this.onAdmit?.();
    return { turnId: `hturn_${input.chatTurnId}` };
  }

  async observe(input: Parameters<ChatHarnessRootPort["observe"]>[0]): Promise<void> {
    this.observations.push(input);
    await this.onObserve?.();
  }

  async settleBeforeProvider(
    input: Parameters<ChatHarnessRootPort["settleBeforeProvider"]>[0],
  ): Promise<void> {
    this.settlements.push(input);
    await this.onSettle?.();
  }
}

class FakeHarnessActors implements ChatHarnessActorTurnPort {
  readonly calls: Parameters<ChatHarnessActorTurnPort["startTurn"]>[0][] = [];
  readonly reconcileCalls: Parameters<ChatHarnessActorTurnPort["reconcileTurn"]>[0][] = [];
  readonly routeCalls: Parameters<ChatHarnessActorTurnPort["routeSessionEvent"]>[0][] = [];
  onRoute: (
    input: Parameters<ChatHarnessActorTurnPort["routeSessionEvent"]>[0],
  ) => ReturnType<ChatHarnessActorTurnPort["routeSessionEvent"]> = () => null;
  onStart: (
    input: Parameters<ChatHarnessActorTurnPort["startTurn"]>[0],
  ) => ReturnType<ChatHarnessActorTurnPort["startTurn"]> = () => Promise.resolve({
    kind: "accepted",
    actorTurnId: "hturn_service_actor01",
    providerTurnId: "turn_service_actor01",
  });
  onReconcile: (
    input: Parameters<ChatHarnessActorTurnPort["reconcileTurn"]>[0],
  ) => ReturnType<ChatHarnessActorTurnPort["reconcileTurn"]> = () => Promise.resolve({
    kind: "accepted",
    actorTurnId: "hturn_service_actor01",
    providerTurnId: "turn_service_actor01",
  });

  startTurn(
    input: Parameters<ChatHarnessActorTurnPort["startTurn"]>[0],
  ): ReturnType<ChatHarnessActorTurnPort["startTurn"]> {
    this.calls.push(structuredClone(input));
    return this.onStart(input);
  }

  routeSessionEvent(
    input: Parameters<ChatHarnessActorTurnPort["routeSessionEvent"]>[0],
  ): ReturnType<ChatHarnessActorTurnPort["routeSessionEvent"]> {
    this.routeCalls.push(structuredClone(input));
    return this.onRoute(input);
  }

  reconcileTurn(
    input: Parameters<ChatHarnessActorTurnPort["reconcileTurn"]>[0],
  ): ReturnType<ChatHarnessActorTurnPort["reconcileTurn"]> {
    this.reconcileCalls.push(structuredClone(input));
    return this.onReconcile(input);
  }
}

interface Harness {
  readonly containedAccounts: string[];
  readonly database: Database;
  readonly deltas: ChatTurnDelta[];
  readonly fullPanes: ChatPaneProjection[];
  readonly panes: ChatPaneProjection[];
  readonly provider: FakeProvider;
  readonly actors: FakeHarnessActors | null;
  readonly roots: FakeHarnessRoots | null;
  readonly runtimeRecoveries: Parameters<ChatRuntimeRecoveryPort["requestRecovery"]>[0][];
  readonly routingEvents: string[];
  readonly rootTurnRouting: RootTurnRoutingAuthorityV1;
  readonly reorderedPanes: (readonly string[])[];
  readonly service: ChatService;
  readonly store: ChatPaneStore;
  readonly workspaces: ChatWorkspacePort;
}

function harness(
  candidateFactory: () =>
    | readonly ChatAccountCandidate[]
    | Promise<readonly ChatAccountCandidate[]> = () => [
    { id: ACCOUNT_ONE, selected: true, budget: "healthy" },
  ],
  containAmbiguousEffect: (accountProfileId: string) => Promise<void> = () => Promise.resolve(),
  roots: FakeHarnessRoots | null = null,
  actors: FakeHarnessActors | null = null,
  beforePaneChanged: ((pane: ChatPaneProjection) => void | Promise<void>) | null = null,
  requestRuntimeRecovery: ChatRuntimeRecoveryPort["requestRecovery"] = () => undefined,
  beforePaneStateChanged: ((pane: ChatPaneProjection) => void | Promise<void>) | null = null,
  repositoryResolver?: ChatServiceOptions["repositories"]["resolve"],
  workspaceRetryDelayMs?: ChatServiceOptions["workspaceRetryDelayMs"],
  attachedHarnessRetryDelayMs?: ChatServiceOptions["attachedHarnessRetryDelayMs"],
  beforeDelta: ((delta: ChatTurnDelta) => void | Promise<void>) | null = null,
  workspaceProvisionOverride: ((
    paneId: string,
    current: ChatPaneProjection,
  ) => Promise<ChatPaneProjection | null>) | null = null,
  interruptTerminalGraceMs = 5,
  hasRateLimitProofSince: NonNullable<ChatAccountPort["hasRateLimitProofSince"]> =
    () => false,
  harnessRootTransitionTimeoutMs = 5_000,
  interruptAckTimeoutMs = 5_000,
  accountContainmentTimeoutMs = 5_000,
  harnessActorTransitionTimeoutMs = 5_000,
): Harness {
  const database = Database.deserialize(pristineDatabase.slice(), { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  const panes: ChatPaneProjection[] = [];
  const fullPanes: ChatPaneProjection[] = [];
  const deltas: ChatTurnDelta[] = [];
  const reorderedPanes: (readonly string[])[] = [];
  const projection: ChatProjectionSink = {
    messageQueueChanged: () => undefined,
    paneChanged: async (pane) => {
      await beforePaneChanged?.(pane);
      fullPanes.push(pane);
      panes.push(pane);
    },
    paneStateChanged: async (pane) => {
      await beforePaneStateChanged?.(pane);
      panes.push(pane);
    },
    paneRemoved: () => undefined,
    panesReordered: (orderedPaneIds) => {
      reorderedPanes.push([...orderedPaneIds]);
    },
    delta: async (delta) => {
      await beforeDelta?.(delta);
      deltas.push(delta);
    },
  };
  const provider = new FakeProvider();
  const routingEvents: string[] = [];
  provider.events = routingEvents;
  const store = new ChatPaneStore(database);
  const rootTurnRouting = recordingRootTurnRoutingAuthority(
    new RootTurnRoutingSQLiteAuthorityV1(database),
    database,
    routingEvents,
    roots !== null,
  );
  let timestamp = Date.parse("2026-08-03T12:00:00.000Z");
  const workspaces: ChatWorkspacePort = {
    async provision(paneId) {
      const current = store.require(paneId).projection;
      const overridden = await workspaceProvisionOverride?.(paneId, current) ?? null;
      if (overridden !== null) return overridden;
      if (current.interactionMode !== "chat" || current.workspace?.state === "ready") {
        return current;
      }
      database.query(`
        UPDATE chat_panes SET workspace_mode = 'managed_worktree',
          workspace_state = 'ready', workspace_recovery_reason = NULL,
          workspace_revision = workspace_revision + 1,
          revision = revision + 1, updated_at = ?2
        WHERE pane_id = ?1 AND archived_at IS NULL
      `).run(paneId, "2026-08-03T12:00:00.000Z");
      return store.require(paneId).projection;
    },
    resolve(paneId, repository) {
      const pane = store.require(paneId).projection;
      return Promise.resolve(pane.workspace?.state === "ready"
        ? {
            ...repository,
            workingDirectory: `/fixture/managed/${paneId}`,
          }
        : null);
    },
    markRepositoryUnavailable(paneId) {
      database.query(`
        UPDATE chat_panes SET workspace_state = 'recovery_required',
          workspace_recovery_reason = 'unknown',
          workspace_revision = workspace_revision + 1,
          revision = revision + 1, updated_at = ?2
        WHERE pane_id = ?1 AND archived_at IS NULL
          AND workspace_state != 'preserved'
      `).run(paneId, "2026-08-03T12:00:00.000Z");
      return store.require(paneId).projection;
    },
    release() {},
  };
  const containedAccounts: string[] = [];
  const runtimeRecoveries: Parameters<ChatRuntimeRecoveryPort["requestRecovery"]>[0][] = [];
  const service = new ChatService({
    accounts: {
      containAmbiguousEffect: (accountProfileId) => {
        containedAccounts.push(accountProfileId);
        return containAmbiguousEffect(accountProfileId);
      },
      refreshCandidates: async () => await candidateFactory(),
      hasRateLimitProofSince,
    },
    now: () => new Date(timestamp++),
    ...(actors === null ? {} : { harnessActors: actors }),
    ...(roots === null ? {} : { harnessRoots: roots }),
    projection,
    provider,
    repositories: {
      resolve: repositoryResolver ?? ((repositoryId) => Promise.resolve(
        repositoryId === REPOSITORY
          ? { id: REPOSITORY, name: "Example", workingDirectory: "/fixture/example" }
          : repositoryId === REPOSITORY_TWO
          ? { id: REPOSITORY_TWO, name: "Other", workingDirectory: "/fixture/other" }
          : null,
      )),
    },
    runtimeRecovery: {
      requestRecovery(input) {
        runtimeRecoveries.push(structuredClone(input));
        requestRuntimeRecovery(input);
      },
    },
    rootTurnRouting,
    store,
    workspaces,
    interruptTerminalGraceMs,
    harnessRootTransitionTimeoutMs,
    interruptAckTimeoutMs,
    accountContainmentTimeoutMs,
    harnessActorTransitionTimeoutMs,
    ...(attachedHarnessRetryDelayMs === undefined
      ? {}
      : { attachedHarnessRetryDelayMs }),
    ...(workspaceRetryDelayMs === undefined ? {} : { workspaceRetryDelayMs }),
  });
  return {
    containedAccounts,
    database,
    deltas,
    fullPanes,
    panes,
    provider,
    actors,
    roots,
    reorderedPanes,
    runtimeRecoveries,
    routingEvents,
    rootTurnRouting,
    service,
    store,
    workspaces,
  };
}

function recordingRootTurnRoutingAuthority(
  delegate: RootTurnRoutingAuthorityV1,
  database: Database,
  events: string[] | null,
  allowSyntheticRootBinding: boolean,
): RootTurnRoutingAuthorityV1 {
  if (events === null) return delegate;
  return {
    admitClassification(input) {
      events.push("routing.classified");
      return delegate.admitClassification(input);
    },
    bindRootTurn(input) {
      events.push("routing.rootBound");
      if (allowSyntheticRootBinding) {
        const receipt = delegate.readTurnRouting(input.paneId, input.chatTurnId);
        if (receipt === null) throw new Error("Expected admitted route receipt");
        return {
          ...receipt,
          rootTurnId: input.rootTurnId,
          updatedAt: input.now.toISOString(),
        };
      }
      return delegate.bindRootTurn(input);
    },
    resolve(input) {
      events.push(`routing.resolved:${input.selectedProfile}`);
      return delegate.resolve(input);
    },
    markEffectStarted(input) {
      events.push("routing.effectStarted");
      return delegate.markEffectStarted(input);
    },
    accept(input) {
      const row = database.query<{
        active_provider_turn_id: string | null;
      }, [string]>(`
        SELECT active_provider_turn_id FROM chat_panes WHERE pane_id = ?1
      `).get(input.paneId);
      events.push(row?.active_provider_turn_id === null
        ? "routing.accepted:paneUnbound"
        : "routing.accepted:paneAlreadyBound");
      return delegate.accept(input);
    },
    settle(input) {
      events.push(`routing.settled:${input.outcome}`);
      return delegate.settle(input);
    },
    readTurnRouting(paneId, chatTurnId) {
      return delegate.readTurnRouting(paneId, chatTurnId);
    },
    readLatestTurnRouting(paneId) {
      return delegate.readLatestTurnRouting(paneId);
    },
  };
}

test("pane reorder binds the expected order through service, projection, and restart", async () => {
  const value = harness();
  try {
    await createPane(value, PANE);
    await createPane(value, PANE_TWO);
    await createPane(value, PANE_THREE);
    const initial = value.store.list().map(({ id }) => id);
    const orderedPaneIds = [PANE_THREE, PANE, PANE_TWO];

    expect(await value.service.execute({
      type: "chat.panes.reorder",
      expectedOrderedPaneIds: initial,
      orderedPaneIds,
    })).toEqual({ type: "reordered", orderedPaneIds });
    expect(value.reorderedPanes).toEqual([orderedPaneIds]);
    expect(value.store.list().map(({ id }) => id)).toEqual(orderedPaneIds);
    expect(new ChatPaneStore(value.database).list().map(({ id }) => id)).toEqual(orderedPaneIds);

    const reduced = reduceRuntimeProjectionEvent({
      ...emptyRuntimeSnapshot(),
      chat: {
        revision: 3,
        panes: initial.map((paneId) => value.store.require(paneId).projection),
      },
    }, {
      type: "chat.panes.reordered",
      orderedPaneIds,
    });
    expect(reduced.chat.panes.map(({ id }) => id)).toEqual(orderedPaneIds);

    const staleReorder = await value.service.execute({
      type: "chat.panes.reorder",
      expectedOrderedPaneIds: initial,
      orderedPaneIds: initial,
    }).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(staleReorder).toMatchObject({ code: "conflict" });
    expect(value.reorderedPanes).toEqual([orderedPaneIds]);
  } finally {
    value.service.closeAdmission();
    await value.service.settled();
    value.database.close();
  }
});

async function createPane(
  value: Harness,
  paneId = PANE,
): Promise<ChatPaneProjection> {
  const result = await value.service.execute({
    type: "chat.pane.create",
    paneId,
    repositoryId: REPOSITORY,
  });
  if (result.type !== "pane") throw new Error("Expected a pane response");
  await value.service.settled();
  return value.store.require(paneId).projection;
}

async function startTurn(
  value: Harness,
  expectedRevision: number,
  turnId = TURN_ONE,
  prompt = "Build the compact UI",
  paneId = PANE,
): Promise<ChatPaneProjection> {
  const result = await value.service.execute({
    type: "chat.turn.start",
    paneId,
    expectedRevision,
    turnId,
    prompt,
  });
  if (result.type !== "pane") throw new Error("Expected a pane response");
  return result.pane;
}

async function stopTurn(
  value: Harness,
  expectedRevision: number,
  turnId = TURN_ONE,
  paneId = PANE,
): Promise<ChatPaneProjection> {
  const result = await value.service.execute({
    type: "chat.turn.stop",
    paneId,
    expectedRevision,
    turnId,
  });
  if (result.type !== "pane") throw new Error("Expected a pane response");
  return result.pane;
}

async function retryTurn(
  value: Harness,
  expectedRevision: number,
  priorFailedTurnId: string,
  turnId = TURN_TWO,
  paneId = PANE,
): Promise<ChatPaneProjection> {
  const result = await value.service.execute({
    type: "chat.turn.retry",
    paneId,
    expectedRevision,
    priorFailedTurnId,
    turnId,
  });
  if (result.type !== "pane") throw new Error("Expected a pane response");
  return result.pane;
}

function attachObserver(
  value: Harness,
  actorId = "hactor_serviceobserver01",
): ChatPaneProjection {
  return value.database.transaction(() =>
    value.store.createAttachedHarnessSession({
      actorId,
      repository: {
        id: REPOSITORY,
        name: "Example",
        workingDirectory: "/fixture/example",
      },
      binding: {
        accountProfileId: ACCOUNT_ONE,
        threadId: "thread_service_observer",
        restartThreadId: "raw_thread_service_observer",
      },
      title: "Observer",
      now: new Date("2026-08-03T12:00:00.000Z"),
    }).pane
  )();
}

test("native steer failure after the effect cut pauses on a visible ambiguous receipt", async () => {
  const value = harness();
  try {
    const ready = await createPane(value);
    await startTurn(value, ready.revision);
    await value.service.settled();
    value.provider.onSteerTurn = () => Promise.reject(
      new ChatProviderEffectError({ certainty: "ambiguous", code: "runtime" }),
    );

    const failure = await value.service.execute({
      type: "chat.message.enqueue",
      paneId: PANE,
      expectedQueueRevision: 1,
      messageId: "chatmsg_serviceambiguous1",
      content: { text: "steer this active turn", attachmentRefs: [] },
      delivery: { kind: "steerHead", expectedTurnId: TURN_ONE },
    }).then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ code: "invalid_state" });
    expect(value.provider.steeredTurns).toHaveLength(1);
    expect(value.store.messageQueue(PANE)).toMatchObject({
      pauseReason: "ambiguousEffect",
      blockedMessage: {
        id: "chatmsg_serviceambiguous1",
        text: "steer this active turn",
        deliveryOutcome: "deliveryOutcomeUnknown",
      },
      messages: [],
    });
  } finally {
    value.service.closeAdmission();
    await value.service.settled();
    value.database.close();
  }
});

test("provider steer acknowledgement cannot escape a failed durable ledger acknowledgement", async () => {
  const value = harness();
  try {
    const ready = await createPane(value);
    await startTurn(value, ready.revision);
    await value.service.settled();
    Object.defineProperty(value.store, "acknowledgeMessageEffect", {
      configurable: true,
      value: () => {
        throw new Error("fixture acknowledgement store failure");
      },
    });

    const failure = await value.service.execute({
      type: "chat.message.enqueue",
      paneId: PANE,
      expectedQueueRevision: 1,
      messageId: "chatmsg_serviceackfail1",
      content: { text: "provider accepts before store fails", attachmentRefs: [] },
      delivery: { kind: "steerHead", expectedTurnId: TURN_ONE },
    }).then(() => null, (error: unknown) => error);
    expect(value.provider.steeredTurns).toHaveLength(1);
    expect(failure).toMatchObject({ code: "invalid_state" });
    expect(value.store.messageQueue(PANE)).toMatchObject({
      pauseReason: "ambiguousEffect",
      blockedMessage: {
        id: "chatmsg_serviceackfail1",
        deliveryOutcome: "deliveryOutcomeUnknown",
      },
    });
    expect(value.runtimeRecoveries).toEqual([]);
  } finally {
    value.service.closeAdmission();
    await value.service.settled();
    value.database.close();
  }
});

test("root routing owns the profile and tier for every ordinary turn", async () => {
  const value = harness();
  try {
    const created = await value.service.execute({
      type: "chat.pane.create",
      paneId: PANE,
      repositoryId: REPOSITORY,
    });
    if (created.type !== "pane") throw new Error("Expected pane");
    await value.service.settled();
    const ready = value.store.require(PANE).projection;
    await startTurn(
      value,
      ready.revision,
      TURN_ONE,
      "Implement the new routing feature across the frontend and backend.",
    );
    await value.service.settled();

    expect(value.provider.startedTurns[0]?.request).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      serviceTier: "standard",
    });
    expect(value.rootTurnRouting.readTurnRouting(PANE, TURN_ONE)).toMatchObject({
      requestedProfile: "solUltra",
      requestedServiceTier: "standard",
      selectedProfile: "solUltra",
      selectedServiceTier: "standard",
      state: "accepted",
    });
  } finally {
    value.service.closeAdmission();
    await value.service.settled();
    value.database.close();
  }
});

test("bounded-leaf routing resolves Luna Fast before every provider effect", async () => {
  const value = harness();
  try {
    const created = await value.service.execute({
      type: "chat.pane.create",
      paneId: PANE,
      repositoryId: REPOSITORY,
    });
    if (created.type !== "pane") throw new Error("Expected pane");
    await value.service.settled();
    const ready = value.store.require(PANE).projection;
    await startTurn(value, ready.revision, TURN_ONE, "Fix the typo in the button label.");
    await value.service.settled();

    expect(value.provider.validations).toEqual([{
      accountProfileId: ACCOUNT_ONE,
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      serviceTier: "fast",
    }]);
    expect(value.provider.startedThreads[0]).toMatchObject({
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      serviceTier: "fast",
    });
    expect(value.provider.startedTurns[0]?.request).toMatchObject({
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      serviceTier: "fast",
    });
    expect(value.rootTurnRouting.readTurnRouting(PANE, TURN_ONE)).toMatchObject({
      requestedProfile: "lunaMax",
      requestedServiceTier: "fast",
      selectedProfile: "lunaMax",
      selectedServiceTier: "fast",
      state: "accepted",
      acceptedGeneration: 1,
      acceptedStreamPosition: 1,
    });
    expect(value.routingEvents).toEqual([
      "provider.resolve:gpt-5.6-luna:max:fast",
      "routing.resolved:lunaMax",
      "routing.effectStarted",
      "provider.startThread",
      "provider.startThread.accepted",
      "provider.startTurn",
      "provider.startTurn.accepted",
      "routing.accepted:paneUnbound",
    ]);
  } finally {
    value.service.closeAdmission();
    await value.service.settled();
    value.database.close();
  }
});

test("an existing thread resumes with the new selected route after effect evidence", async () => {
  const value = harness();
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision, TURN_ONE, "Review this function for a bug.");
    await value.service.settled();
    const first = value.provider.startedTurns[0];
    if (first === undefined) throw new Error("Expected first provider turn");
    await value.service.observeSessionAssistantCompletion(
      completion(first.request, first.turnId, "The first answer."),
    );
    await value.service.observeSessionLifecycle(
      lifecycle(first.request, first.turnId, "completed"),
    );
    await value.service.settled();
    value.routingEvents.length = 0;

    await startTurn(
      value,
      value.store.require(PANE).projection.revision,
      TURN_TWO,
      "Fix the typo in the button label.",
    );
    await value.service.settled();

    expect(value.routingEvents).toEqual([
      "provider.resolve:gpt-5.6-luna:max:fast",
      "routing.resolved:lunaMax",
      "routing.effectStarted",
      "provider.resumeThread",
      "provider.startTurn",
      "provider.startTurn.accepted",
      "routing.accepted:paneUnbound",
    ]);
    expect(value.provider.resumedThreads[0]).toMatchObject({
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      serviceTier: "fast",
    });
    expect(value.provider.startedTurns[1]?.request).toMatchObject({
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      serviceTier: "fast",
    });
  } finally {
    value.service.closeAdmission();
    await value.service.settled();
    value.database.close();
  }
});

test("standard and broad prompts send their exact router-owned Sol profiles", async () => {
  const cases = [
    {
      prompt: "Review this function for a possible bug.",
      model: "gpt-5.6-sol" as const,
      reasoningEffort: "max" as const,
      selectedProfile: "solMax" as const,
      serviceTier: "standard" as const,
    },
    {
      prompt: "Implement the new routing feature across the frontend and backend.",
      model: "gpt-5.6-sol" as const,
      reasoningEffort: "ultra" as const,
      selectedProfile: "solUltra" as const,
      serviceTier: "standard" as const,
    },
  ];
  for (const expected of cases) {
    const value = harness();
    try {
      const created = await value.service.execute({
        type: "chat.pane.create",
        paneId: PANE,
        repositoryId: REPOSITORY,
      });
      if (created.type !== "pane") throw new Error("Expected pane");
      await value.service.settled();
      await startTurn(
        value,
        value.store.require(PANE).projection.revision,
        TURN_ONE,
        expected.prompt,
      );
      await value.service.settled();
      expect(value.provider.startedTurns[0]?.request).toMatchObject({
        model: expected.model,
        reasoningEffort: expected.reasoningEffort,
        serviceTier: expected.serviceTier,
      });
      expect(value.rootTurnRouting.readTurnRouting(PANE, TURN_ONE)).toMatchObject({
        selectedProfile: expected.selectedProfile,
        state: "accepted",
      });
    } finally {
      value.service.closeAdmission();
      await value.service.settled();
      value.database.close();
    }
  }
});

test("continuations inherit settled Ultra and Luna routes across reopen", async () => {
  const cases = [
    {
      prompt: "Implement the new routing feature across the frontend and backend.",
      workClass: "largeChange" as const,
      profile: "solUltra" as const,
      model: "gpt-5.6-sol" as const,
      effort: "ultra" as const,
      tier: "standard" as const,
    },
    {
      prompt: "Fix the typo in the button label.",
      workClass: "boundedLeaf" as const,
      profile: "lunaMax" as const,
      model: "gpt-5.6-luna" as const,
      effort: "max" as const,
      tier: "fast" as const,
    },
  ];
  for (const expected of cases) {
    const value = harness();
    let restarted: ChatService | null = null;
    try {
      const created = await createPane(value);
      await startTurn(value, created.revision, TURN_ONE, expected.prompt);
      await value.service.settled();
      const first = value.provider.startedTurns[0];
      if (first === undefined) throw new Error("Expected first provider turn");
      await value.service.observeSessionLifecycle(
        lifecycle(first.request, first.turnId, "completed"),
      );
      await value.service.settled();
      value.service.closeAdmission();
      await value.service.settled();

      const restartedProvider = new FakeProvider();
      const authority = new RootTurnRoutingSQLiteAuthorityV1(value.database);
      restarted = new ChatService({
        accounts: {
          containAmbiguousEffect: () => Promise.resolve(),
          refreshCandidates: () => Promise.resolve([
            { id: ACCOUNT_ONE, selected: true, budget: "healthy" },
          ]),
        },
        projection: {
          messageQueueChanged: () => undefined,
          paneChanged: () => undefined,
          paneStateChanged: () => undefined,
          paneRemoved: () => undefined,
          panesReordered: () => undefined,
          delta: () => undefined,
        },
        provider: restartedProvider,
        repositories: {
          resolve: (repositoryId) => Promise.resolve(repositoryId === REPOSITORY
            ? { id: REPOSITORY, name: "Example", workingDirectory: "/fixture/example" }
            : null),
        },
        rootTurnRouting: authority,
        runtimeRecovery: { requestRecovery: () => undefined },
        store: value.store,
        workspaces: value.workspaces,
      });
      restarted.initialize();
      await restarted.execute({
        type: "chat.turn.start",
        paneId: PANE,
        expectedRevision: value.store.require(PANE).projection.revision,
        turnId: TURN_TWO,
        prompt: "continue",
      });
      await restarted.settled();

      expect(restartedProvider.startedTurns[0]?.request).toMatchObject({
        model: expected.model,
        reasoningEffort: expected.effort,
        serviceTier: expected.tier,
      });
      expect(authority.readTurnRouting(PANE, TURN_TWO)).toMatchObject({
        classificationReason: "continuationInherited",
        workClass: expected.workClass,
        requestedProfile: expected.profile,
        requestedServiceTier: expected.tier,
        selectedProfile: expected.profile,
        selectedServiceTier: expected.tier,
        state: "accepted",
      });
    } finally {
      restarted?.closeAdmission();
      await restarted?.settled();
      value.service.closeAdmission();
      await value.service.settled();
      value.database.close();
    }
  }
});

test("a continuation without prior route requests Sol Max Fast", async () => {
  const value = harness();
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision, TURN_ONE, "continue it");
    await value.service.settled();

    expect(value.provider.startedTurns[0]?.request).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      serviceTier: "fast",
    });
    expect(value.rootTurnRouting.readTurnRouting(PANE, TURN_ONE)).toMatchObject({
      classificationReason: "continuationOrAmbiguous",
      requestedProfile: "solMax",
      requestedServiceTier: "fast",
      selectedProfile: "solMax",
      selectedServiceTier: "fast",
    });
  } finally {
    value.service.closeAdmission();
    await value.service.settled();
    value.database.close();
  }
});

test("Luna Fast fallback follows the exact capability-only candidate order", async () => {
  const value = harness();
  value.provider.onResolveConfiguration = (_account, candidates) => {
    const selected = candidates.find(({ model, serviceTier }) =>
      model === "gpt-5.6-sol" && serviceTier === "standard"
    );
    return selected === undefined
      ? Promise.reject(new ChatProviderEffectError({
          certainty: "not_applied",
          code: "capability_unavailable",
        }))
      : Promise.resolve(selected);
  };
  try {
    const created = await value.service.execute({
      type: "chat.pane.create",
      paneId: PANE,
      repositoryId: REPOSITORY,
    });
    if (created.type !== "pane") throw new Error("Expected pane");
    await value.service.settled();
    await startTurn(
      value,
      value.store.require(PANE).projection.revision,
      TURN_ONE,
      "Fix the typo in the button label.",
    );
    await value.service.settled();

    expect(value.provider.resolutionCandidates[0]?.map(({ model, serviceTier }) => ({
      model,
      serviceTier,
    }))).toEqual([
      { model: "gpt-5.6-luna", serviceTier: "fast" },
      { model: "gpt-5.6-luna", serviceTier: "standard" },
      { model: "gpt-5.6-sol", serviceTier: "fast" },
      { model: "gpt-5.6-sol", serviceTier: "standard" },
    ]);
    expect(value.provider.startedTurns[0]?.request).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      serviceTier: "standard",
    });
    expect(value.rootTurnRouting.readTurnRouting(PANE, TURN_ONE)).toMatchObject({
      requestedProfile: "lunaMax",
      requestedServiceTier: "fast",
      selectedProfile: "solMax",
      profileFallbackReason: "lunaUnavailable",
      selectedServiceTier: "standard",
      serviceTierFallbackReason: "fastUnavailable",
      state: "accepted",
    });
  } finally {
    value.service.closeAdmission();
    await value.service.settled();
    value.database.close();
  }
});

test("catalog uncertainty never masquerades as route capability absence", async () => {
  const value = harness();
  value.provider.onResolveConfiguration = () => Promise.reject(
    new ChatProviderEffectError({ certainty: "not_applied", code: "runtime" }),
  );
  try {
    const created = await value.service.execute({
      type: "chat.pane.create",
      paneId: PANE,
      repositoryId: REPOSITORY,
    });
    if (created.type !== "pane") throw new Error("Expected pane");
    await value.service.settled();
    await startTurn(
      value,
      value.store.require(PANE).projection.revision,
      TURN_ONE,
      "Fix the typo in the button label.",
    );
    await value.service.settled();

    expect(value.provider.resolutionCandidates[0]?.[0]?.model)
      .toBe("gpt-5.6-luna");
    expect(value.provider.validations).toEqual([]);
    expect(value.provider.startedThreads).toEqual([]);
    expect(value.provider.startedTurns).toEqual([]);
    expect(value.rootTurnRouting.readTurnRouting(PANE, TURN_ONE)).toMatchObject({
      requestedProfile: "lunaMax",
      selectedProfile: null,
      state: "notApplied",
      operationalOutcome: "notApplied",
    });
  } finally {
    value.service.closeAdmission();
    await value.service.settled();
    value.database.close();
  }
});

test("an ambiguous provider effect is contained without model fallback", async () => {
  const value = harness();
  value.provider.onStartThread = () => Promise.reject(
    new ChatProviderEffectError({ certainty: "ambiguous", code: "runtime" }),
  );
  try {
    const created = await value.service.execute({
      type: "chat.pane.create",
      paneId: PANE,
      repositoryId: REPOSITORY,
    });
    if (created.type !== "pane") throw new Error("Expected pane");
    await value.service.settled();
    await startTurn(
      value,
      value.store.require(PANE).projection.revision,
      TURN_ONE,
      "Fix the typo in the button label.",
    );
    await value.service.settled();

    expect(value.provider.validations.map(({ model }) => model)).toEqual([
      "gpt-5.6-luna",
    ]);
    expect(value.containedAccounts).toEqual([ACCOUNT_ONE]);
    expect(value.provider.startedTurns).toEqual([]);
    expect(value.rootTurnRouting.readTurnRouting(PANE, TURN_ONE)).toMatchObject({
      selectedProfile: "lunaMax",
      state: "ambiguous",
      operationalOutcome: "ambiguous",
    });
  } finally {
    value.service.closeAdmission();
    await value.service.settled();
    value.database.close();
  }
});

test("a definitive turn-start rejection after thread creation settles failed, not notApplied", async () => {
  const value = harness();
  value.provider.onStartTurn = () => Promise.reject(
    new ChatProviderEffectError({ certainty: "not_applied", code: "rejected" }),
  );
  try {
    const created = await value.service.execute({
      type: "chat.pane.create",
      paneId: PANE,
      repositoryId: REPOSITORY,
    });
    if (created.type !== "pane") throw new Error("Expected pane");
    await value.service.settled();
    await startTurn(
      value,
      value.store.require(PANE).projection.revision,
      TURN_ONE,
      "Fix the typo in the button label.",
    );
    await value.service.settled();

    expect(value.provider.startedThreads).toHaveLength(1);
    expect(value.provider.validations.map(({ model }) => model)).toEqual([
      "gpt-5.6-luna",
    ]);
    expect(value.rootTurnRouting.readTurnRouting(PANE, TURN_ONE)).toMatchObject({
      selectedProfile: "lunaMax",
      state: "terminal",
      operationalOutcome: "failed",
    });
  } finally {
    value.service.closeAdmission();
    await value.service.settled();
    value.database.close();
  }
});

test("a turn-start rejection after history injection still settles the route failed", async () => {
  let candidates: readonly ChatAccountCandidate[] = [
    { id: ACCOUNT_ONE, selected: true, budget: "healthy" },
  ];
  const value = harness(() => candidates);
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision, TURN_ONE, "Review this function for a bug.");
    await value.service.settled();
    const first = value.provider.startedTurns[0];
    if (first === undefined) throw new Error("Expected first provider turn");
    await value.service.observeSessionAssistantCompletion(
      completion(first.request, first.turnId, "The first answer."),
    );
    await value.service.observeSessionLifecycle(
      lifecycle(first.request, first.turnId, "completed"),
    );
    await value.service.settled();
    value.routingEvents.length = 0;

    candidates = [{ id: ACCOUNT_TWO, selected: true, budget: "healthy" }];
    value.provider.onStartTurn = () => Promise.reject(
      new ChatProviderEffectError({ certainty: "not_applied", code: "rejected" }),
    );
    await startTurn(
      value,
      value.store.require(PANE).projection.revision,
      TURN_TWO,
      "Review this function for another bug.",
    );
    await value.service.settled();

    expect(value.provider.startedThreads).toHaveLength(2);
    expect(value.provider.injected).toHaveLength(1);
    expect(value.provider.injected[0]?.history).toEqual([
      { role: "user", text: "Review this function for a bug." },
      { role: "assistant", text: "The first answer." },
    ]);
    expect(value.routingEvents.indexOf("routing.effectStarted")).toBeLessThan(
      value.routingEvents.indexOf("provider.startThread"),
    );
    expect(value.routingEvents.indexOf("provider.startThread")).toBeLessThan(
      value.routingEvents.indexOf("provider.injectHistory"),
    );
    expect(value.routingEvents.indexOf("provider.injectHistory")).toBeLessThan(
      value.routingEvents.indexOf("provider.startTurn"),
    );
    expect(value.rootTurnRouting.readTurnRouting(PANE, TURN_TWO)).toMatchObject({
      selectedProfile: "solMax",
      selectedServiceTier: "standard",
      state: "terminal",
      operationalOutcome: "failed",
    });
  } finally {
    value.service.closeAdmission();
    await value.service.settled();
    value.database.close();
  }
});

test("an unexpected post-effect routing evidence failure fences recovery", async () => {
  const value = harness();
  value.provider.onStartTurn = () => Promise.reject(
    new ChatProviderEffectError({ certainty: "not_applied", code: "rejected" }),
  );
  value.rootTurnRouting.settle = () => {
    throw new Error("fixture routing evidence failure");
  };
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision, TURN_ONE, "Review this function for a bug.");
    await value.service.settled();

    expect(value.rootTurnRouting.readTurnRouting(PANE, TURN_ONE)).toMatchObject({
      state: "effectStarted",
      selectedProfile: "solMax",
      selectedServiceTier: "standard",
      operationalOutcome: null,
    });
    expect(value.store.require(PANE).activeTurnPoisoned).toBeTrue();
    expect(value.runtimeRecoveries).toHaveLength(1);
    expect(value.runtimeRecoveries[0]).toMatchObject({
      paneId: PANE,
      turnId: TURN_ONE,
      reason: "ambiguous_provider_effect_unfenced",
    });
  } finally {
    value.service.closeAdmission();
    await value.service.settled();
    value.database.close();
  }
});

test("a definitive quota rejection terminalizes the selected route without fallback", async () => {
  const value = harness();
  value.provider.onStartTurn = () => Promise.reject(
    new ChatProviderEffectError({
      certainty: "not_applied",
      code: "quota_reached",
      quotaProof: "provider_rate_limit_reached",
    }),
  );
  try {
    const created = await value.service.execute({
      type: "chat.pane.create",
      paneId: PANE,
      repositoryId: REPOSITORY,
    });
    if (created.type !== "pane") throw new Error("Expected pane");
    await value.service.settled();
    await startTurn(
      value,
      value.store.require(PANE).projection.revision,
      TURN_ONE,
      "Fix the typo in the button label.",
    );
    await value.service.settled();

    expect(value.provider.validations.map(({ model }) => model)).toEqual([
      "gpt-5.6-luna",
    ]);
    expect(value.rootTurnRouting.readTurnRouting(PANE, TURN_ONE)).toMatchObject({
      selectedProfile: "lunaMax",
      state: "terminal",
      operationalOutcome: "quotaRejected",
    });
    expect(value.store.require(PANE).projection).toMatchObject({
      state: "attention",
      attention: { code: "all_accounts_exhausted" },
    });
  } finally {
    value.service.closeAdmission();
    await value.service.settled();
    value.database.close();
  }
});

test("turn start responds at revision +1 while settled drains later pane-tail work", async () => {
  const value = harness();
  try {
    const created = await createPane(value);
    const entered = deferred<void>();
    const release = deferred<string>();
    value.provider.onStartTurn = async () => {
      entered.resolve();
      return await release.promise;
    };

    const response = await startTurn(value, created.revision);
    expect(response).toMatchObject({ revision: created.revision + 1, state: "starting" });
    await entered.promise;

    let didSettle = false;
    const settling = value.service.settled().then(() => { didSettle = true; });
    await Promise.resolve();
    expect(didSettle).toBeFalse();

    const appended = value.service.handleDelta({
      paneId: PANE,
      turnId: TURN_ONE,
      channel: "responseMarkdown",
      delta: "after acceptance",
      assistantMessageId: ASSISTANT_ITEM,
    });
    release.resolve("turn_chat_exact1");
    await settling;
    await appended;

    expect(didSettle).toBeTrue();
    expect(value.store.require(PANE).projection).toMatchObject({
      state: "streaming",
      turn: { responseMarkdown: { tail: "after acceptance" } },
    });
    const revision = value.store.require(PANE).projection.revision;
    await value.service.settled();
    expect(value.store.require(PANE).projection.revision).toBe(revision);
  } finally {
    value.database.close();
  }
});

test("durable turn admission waits for projection capacity without poisoning the turn", async () => {
  const capacity = deferred<void>();
  const projectionEntered = deferred<void>();
  let blockTurnProjection = false;
  const value = harness(undefined, undefined, null, null, (pane) => {
    if (blockTurnProjection && pane.turn?.id === TURN_ONE) {
      projectionEntered.resolve();
      return capacity.promise;
    }
    return undefined;
  });
  try {
    const created = await createPane(value);
    blockTurnProjection = true;
    let returned = false;
    const starting = startTurn(value, created.revision).then((pane) => {
      returned = true;
      return pane;
    });

    await projectionEntered.promise;
    expect(returned).toBeFalse();
    expect(value.provider.startedTurns).toHaveLength(0);
    expect(value.store.require(PANE)).toMatchObject({
      activeTurnPoisoned: false,
      projection: {
        state: "starting",
        turn: { id: TURN_ONE, status: "starting" },
      },
    });

    capacity.resolve();
    expect(await starting).toMatchObject({
      state: "starting",
      turn: { id: TURN_ONE },
    });
    await value.service.settled();
    expect(value.provider.startedTurns).toHaveLength(1);
    expect(value.store.require(PANE)).toMatchObject({
      activeTurnPoisoned: false,
      projection: { state: "streaming", attention: null },
    });
  } finally {
    value.database.close();
  }
});

test("workspace recovery rejects before root, provider, or durable turn admission", async () => {
  const roots = new FakeHarnessRoots();
  const value = harness(undefined, undefined, roots);
  try {
    const ready = await createPane(value);
    value.database.query(`
      UPDATE chat_panes SET workspace_state = 'waiting_capacity',
        workspace_recovery_reason = 'capacity_unavailable',
        workspace_revision = workspace_revision + 1,
        revision = revision + 1,
        updated_at = '2026-08-03T12:00:01.000Z'
      WHERE pane_id = ?1 AND revision = ?2
    `).run(PANE, ready.revision);
    const waiting = value.store.require(PANE).projection;

    const error = await value.service.execute({
      type: "chat.turn.start",
      paneId: PANE,
      expectedRevision: waiting.revision,
      turnId: TURN_ONE,
      prompt: "must remain unadmitted",
    }).then(() => null, (reason: unknown) => reason);

    expect(error).toMatchObject({ code: "invalid_state" });
    await value.service.settled();
    expect(value.store.require(PANE).projection).toEqual(waiting);
    expect(roots.admissions).toEqual([]);
    expect(value.provider.startedThreads).toEqual([]);
    expect(value.provider.startedTurns).toEqual([]);
    expect(value.database.query(`
      SELECT COUNT(*) AS count FROM chat_turn_receipts WHERE pane_id = ?1
    `).get(PANE)).toEqual({ count: 0 });
  } finally {
    value.database.close();
  }
});

test("repository resolution leaves preparation durably and retries to readiness", async () => {
  let resolutions = 0;
  const resolver: ChatServiceOptions["repositories"]["resolve"] = (repositoryId) => {
    resolutions += 1;
    if (resolutions === 2) {
      return Promise.reject(new Error("fixture repository outage"));
    }
    return Promise.resolve(repositoryId === REPOSITORY
      ? { id: REPOSITORY, name: "Example", workingDirectory: "/fixture/example" }
      : null);
  };
  const value = harness(
    undefined,
    undefined,
    null,
    null,
    null,
    undefined,
    null,
    resolver,
    () => 50,
  );
  try {
    await createPane(value);
    const ready = value.store.require(PANE).projection;
    value.database.query(`
      UPDATE chat_panes SET workspace_state = 'recovery_required',
        workspace_recovery_reason = 'unknown',
        workspace_revision = workspace_revision + 1,
        revision = revision + 1
      WHERE pane_id = ?1
    `).run(PANE);
    const needsRetry = value.store.require(PANE).projection;
    await value.service.execute({
      type: "chat.pane.workspace.recover",
      paneId: PANE,
      expectedRevision: needsRetry.revision,
    });
    await value.service.settled();

    const durable = value.store.require(PANE).projection;
    expect(durable.workspace).toMatchObject({
      state: "recoveryRequired",
      recoveryKind: "unknown",
    });
    expect(durable.workspace?.state).not.toBe("preparing");
    expect(value.database.query<{ workspace_recovery_reason: string }, [string]>(`
      SELECT workspace_recovery_reason FROM chat_panes WHERE pane_id = ?1
    `).get(PANE)).toEqual({ workspace_recovery_reason: "unknown" });

    await Bun.sleep(75);
    await value.service.settled();
    expect(value.store.require(PANE).projection.workspace).toMatchObject({
      state: "ready",
      recoveryKind: null,
    });
    expect(resolutions).toBe(3);
    expect(value.store.require(PANE).projection.revision).toBeGreaterThan(ready.revision);
  } finally {
    value.service.closeAdmission();
    value.database.close();
  }
});

test("transient workspace execution capacity retries without durable recovery poison", async () => {
  let capacityMode = false;
  let capacityAttempts = 0;
  const recovered = deferred<void>();
  const retryAttempts: number[] = [];
  let testDatabase: Database | null = null;
  let testStore: ChatPaneStore | null = null;
  const value = harness(
    undefined,
    undefined,
    null,
    null,
    null,
    undefined,
    null,
    undefined,
    (attempt) => {
      retryAttempts.push(attempt);
      return 5;
    },
    undefined,
    null,
    (paneId) => {
      if (!capacityMode) return Promise.resolve(null);
      capacityAttempts += 1;
      if (capacityAttempts > 2) {
        recovered.resolve();
        return Promise.resolve(null);
      }
      if (testDatabase === null || testStore === null) {
        throw new Error("workspace capacity fixture was not installed");
      }
      testDatabase.query(`
        UPDATE chat_panes SET workspace_state = 'preparing',
          workspace_recovery_reason = NULL,
          workspace_revision = workspace_revision + 1,
          revision = revision + 1
        WHERE pane_id = ?1 AND workspace_state IN (
          'waiting_capacity', 'recovery_required'
        )
      `).run(paneId);
      testDatabase.query(`
        UPDATE chat_panes SET workspace_state = 'waiting_capacity',
          workspace_recovery_reason = 'capacity_unavailable',
          workspace_revision = workspace_revision + 1,
          revision = revision + 1
        WHERE pane_id = ?1
      `).run(paneId);
      return Promise.resolve(testStore.require(paneId).projection);
    },
  );
  testDatabase = value.database;
  testStore = value.store;
  try {
    await createPane(value);
    value.database.query(`
      UPDATE chat_panes SET workspace_state = 'recovery_required',
        workspace_recovery_reason = 'unknown',
        workspace_revision = workspace_revision + 1,
        revision = revision + 1
      WHERE pane_id = ?1
    `).run(PANE);
    capacityMode = true;
    const recovering = value.store.require(PANE).projection;
    await value.service.execute({
      type: "chat.pane.workspace.recover",
      paneId: PANE,
      expectedRevision: recovering.revision,
    });
    await value.service.settled();

    expect(value.store.require(PANE).projection.workspace).toMatchObject({
      state: "waitingCapacity",
      recoveryKind: "capacityUnavailable",
    });
    expect(retryAttempts).toEqual([1]);
    await withinDeadline(recovered.promise, "workspace capacity retry", 1_000);
    await value.service.settled();
    expect(value.store.require(PANE).projection.workspace).toMatchObject({
      state: "ready",
      recoveryKind: null,
    });
    expect(capacityAttempts).toBe(3);
    expect(retryAttempts).toEqual([1, 2]);
  } finally {
    value.service.closeAdmission();
    value.database.close();
  }
});

test("closeAdmission cancels an armed workspace retry before it can touch repository state", async () => {
  let resolutions = 0;
  let workspaceAttempts = 0;
  const value = harness(
    undefined,
    undefined,
    null,
    null,
    null,
    undefined,
    null,
    (repositoryId) => {
      resolutions += 1;
      return resolutions === 1
        ? Promise.resolve({
            id: repositoryId,
            name: "Example",
            workingDirectory: "/fixture/example",
          })
        : Promise.reject(new Error("fixture repository outage"));
    },
    () => 25,
    undefined,
    null,
    () => {
      workspaceAttempts += 1;
      return Promise.resolve(null);
    },
  );
  try {
    await createPane(value);
    value.database.query(`
      UPDATE chat_panes SET workspace_state = 'recovery_required',
        workspace_recovery_reason = 'unknown',
        workspace_revision = workspace_revision + 1,
        revision = revision + 1
      WHERE pane_id = ?1
    `).run(PANE);
    const current = value.store.require(PANE).projection;
    await value.service.execute({
      type: "chat.pane.workspace.recover",
      paneId: PANE,
      expectedRevision: current.revision,
    });
    await value.service.settled();
    expect(value.store.require(PANE).projection.workspace?.state)
      .toBe("recoveryRequired");
    const beforeClose = { resolutions, workspaceAttempts };

    value.service.closeAdmission();
    await Bun.sleep(60);
    await value.service.settled();
    expect({ resolutions, workspaceAttempts }).toEqual(beforeClose);
  } finally {
    value.service.closeAdmission();
    value.database.close();
  }
});

test("settled includes an account-unavailable tail admitted after closeAdmission", async () => {
  const projectionEntered = deferred<void>();
  const projectionRelease = deferred<void>();
  let blockDetachment = false;
  const value = harness(
    undefined,
    undefined,
    null,
    null,
    null,
    undefined,
    (pane) => {
      if (blockDetachment && pane.accountProfileId === null) {
        projectionEntered.resolve();
        return projectionRelease.promise;
      }
      return undefined;
    },
  );
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    blockDetachment = true;
    value.service.closeAdmission();

    const handling = value.service.handleAccountUnavailable(ACCOUNT_ONE);
    await projectionEntered.promise;
    let didSettle = false;
    const settling = value.service.settled().then(() => { didSettle = true; });
    await Promise.resolve();
    expect(didSettle).toBeFalse();

    projectionRelease.resolve();
    await handling;
    await settling;
    expect(didSettle).toBeTrue();
    expect(value.store.require(PANE).projection).toMatchObject({
      state: "attention",
      accountProfileId: null,
      attention: { code: "account_unavailable", retryable: true },
      messageQueue: { pauseReason: "attention" },
    });
  } finally {
    projectionRelease.resolve();
    value.service.closeAdmission();
    await value.service.settled();
    value.database.close();
  }
});

test("restart rehydrates a durable repository-resolution recovery without waiting for the old timer", async () => {
  let resolutions = 0;
  const value = harness(
    undefined,
    undefined,
    null,
    null,
    null,
    undefined,
    null,
    (repositoryId) => {
      resolutions += 1;
      return resolutions === 1
        ? Promise.resolve({
            id: repositoryId,
            name: "Example",
            workingDirectory: "/fixture/example",
          })
        : Promise.reject(new Error("fixture repository outage"));
    },
    () => 60_000,
  );
  try {
    await createPane(value);
    value.database.query(`
      UPDATE chat_panes SET workspace_state = 'recovery_required',
        workspace_recovery_reason = 'unknown',
        workspace_revision = workspace_revision + 1,
        revision = revision + 1
      WHERE pane_id = ?1
    `).run(PANE);
    const current = value.store.require(PANE).projection;
    await value.service.execute({
      type: "chat.pane.workspace.recover",
      paneId: PANE,
      expectedRevision: current.revision,
    });
    await value.service.settled();
    expect(value.store.require(PANE).projection.workspace?.state)
      .toBe("recoveryRequired");
    value.service.closeAdmission();

    const restarted = new ChatService({
      accounts: {
        containAmbiguousEffect: () => Promise.resolve(),
        refreshCandidates: () => Promise.resolve([
          { id: ACCOUNT_ONE, selected: true, budget: "healthy" },
        ]),
        hasRateLimitProofSince: () => false,
      },
      projection: {
        messageQueueChanged: () => undefined,
        paneChanged: () => undefined,
        paneStateChanged: () => undefined,
        paneRemoved: () => undefined,
        panesReordered: () => undefined,
        delta: () => undefined,
      },
      provider: value.provider,
      repositories: {
        resolve: (repositoryId) => Promise.resolve({
          id: repositoryId,
          name: "Example",
          workingDirectory: "/fixture/example",
        }),
      },
      runtimeRecovery: { requestRecovery: () => undefined },
      rootTurnRouting: new RootTurnRoutingSQLiteAuthorityV1(value.database),
      store: value.store,
      workspaces: value.workspaces,
    });
    restarted.initialize();
    await restarted.settled();
    expect(value.store.require(PANE).projection.workspace?.state).toBe("ready");
    restarted.closeAdmission();
  } finally {
    value.service.closeAdmission();
    value.database.close();
  }
});

test("root admission precedes provider start and terminal proof settles before pane reuse", async () => {
  const order: string[] = [];
  const roots = new FakeHarnessRoots();
  const value = harness(undefined, undefined, roots);
  try {
    roots.onAdmit = () => { order.push("root:admit"); };
    roots.onObserve = () => {
      order.push("root:terminal");
      expect(value.store.require(PANE).projection.state).toBe("streaming");
    };
    value.provider.onStartTurn = () => {
      order.push("provider:start");
      return Promise.resolve("turn_chat_root_order");
    };

    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected a provider turn");

    await value.service.observeSessionAssistantCompletion({
      accountProfileId: started.request.accountProfileId,
      threadId: started.request.threadId,
      turnId: started.turnId,
      assistantItemId: ASSISTANT_ITEM,
      displayText: "Done",
      truncated: false,
    });
    await value.service.observeSessionLifecycle(
      lifecycle(started.request, started.turnId, "completed"),
    );

    expect(order).toEqual(["root:admit", "provider:start", "root:terminal"]);
    expect(roots.admissions).toEqual([{
      repositoryId: REPOSITORY,
      canonicalWorkingDirectory: `/fixture/managed/${PANE}`,
      paneId: PANE,
      chatTurnId: TURN_ONE,
      title: "New chat",
      prompt: "Build the compact UI",
      createdAt: "2026-08-03T12:00:00.001Z",
    }]);
    expect(roots.observations).toEqual([
      lifecycle(started.request, started.turnId, "completed"),
    ]);
    expect(roots.settlements).toEqual([]);
    expect(value.store.require(PANE).projection.state).toBe("ready");
  } finally {
    value.database.close();
  }
});

test("a root with no available provider is terminalized before attention", async () => {
  const roots = new FakeHarnessRoots();
  const value = harness(() => [], undefined, roots);
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();

    expect(value.provider.startedTurns).toEqual([]);
    expect(roots.admissions).toHaveLength(1);
    expect(roots.settlements).toHaveLength(1);
    expect(roots.settlements[0]).toMatchObject({
      turnId: `hturn_${TURN_ONE}`,
      paneId: PANE,
      failure: "provider_unavailable",
    });
    expect(typeof roots.settlements[0]?.settledAt).toBe("string");
    expect(value.store.require(PANE).projection).toMatchObject({
      state: "attention",
      attention: { code: "account_required" },
    });
  } finally {
    value.database.close();
  }
});

test("an ambiguous provider start terminalizes the exact root as ambiguous", async () => {
  const roots = new FakeHarnessRoots();
  const value = harness(undefined, undefined, roots);
  try {
    value.provider.onStartTurn = () => Promise.reject(new ChatProviderEffectError({
      certainty: "ambiguous",
      code: "runtime",
    }));
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();

    expect(roots.settlements).toHaveLength(1);
    expect(roots.settlements[0]).toMatchObject({
      turnId: `hturn_${TURN_ONE}`,
      paneId: PANE,
      failure: "provider_start_ambiguous",
    });
    expect(typeof roots.settlements[0]?.settledAt).toBe("string");
    expect(value.containedAccounts).toEqual([ACCOUNT_ONE]);
    expect(value.store.require(PANE).projection.state).toBe("attention");
  } finally {
    value.database.close();
  }
});

test("replaying an admitted logical turn is a conflict with no provider side effect", async () => {
  const value = harness();
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision, TURN_ONE, "One logical request");
    await value.service.settled();
    const before = value.store.require(PANE);
    expect(before.projection).toMatchObject({
      state: "streaming",
      turn: { id: TURN_ONE, status: "streaming" },
    });
    expect(value.provider.startedThreads).toHaveLength(1);
    expect(value.provider.startedTurns).toHaveLength(1);

    const replayError = await value.service.execute({
      type: "chat.turn.start",
      paneId: PANE,
      expectedRevision: before.projection.revision,
      turnId: TURN_ONE,
      prompt: "One logical request",
    }).then(() => null, (error: unknown) => error);
    expect(replayError).toMatchObject({ code: "conflict" });
    await value.service.settled();

    expect(value.store.require(PANE)).toEqual(before);
    expect(value.provider.startedThreads).toHaveLength(1);
    expect(value.provider.startedTurns).toHaveLength(1);
    expect(value.provider.interrupts).toHaveLength(0);
  } finally {
    value.database.close();
  }
});

test("harness observer panes without the trusted actor bridge reject before admission", async () => {
  const value = harness();
  try {
    const pane = attachObserver(value);
    const before = value.store.require(pane.id);

    const error = await value.service.execute({
      type: "chat.turn.start",
      paneId: pane.id,
      expectedRevision: pane.revision,
      turnId: TURN_ONE,
      prompt: "must remain private and unadmitted",
    }).then(() => null, (reason: unknown) => reason);

    expect(error).toMatchObject({ code: "invalid_state" });
    await value.service.settled();
    expect(value.store.require(pane.id)).toEqual(before);
    expect(value.provider.startedThreads).toHaveLength(0);
    expect(value.provider.startedTurns).toHaveLength(0);
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM chat_turn_receipts WHERE pane_id = ?1",
    ).get(pane.id)).toEqual({ count: 0 });
  } finally {
    value.database.close();
  }
});

test("attached actor admission drains exact early events and never observes a root turn", async () => {
  const roots = new FakeHarnessRoots();
  const actors = new FakeHarnessActors();
  const value = harness(undefined, undefined, roots, actors);
  try {
    const pane = attachObserver(value);
    actors.onStart = async () => {
      await value.service.observeSessionActivity({
        accountProfileId: ACCOUNT_ONE,
        threadId: "thread_service_observer",
        turnId: "turn_service_actor01",
        kind: "assistant_message_delta",
        assistantItemId: ASSISTANT_ITEM,
        displayText: "Early answer",
      });
      return {
        kind: "accepted",
        actorTurnId: "hturn_service_actor01",
        providerTurnId: "turn_service_actor01",
      };
    };
    actors.onReconcile = () => Promise.resolve({
      kind: "settled",
      actorTurnId: "hturn_service_actor01",
      outcome: "succeeded",
      responseMarkdown: "Early answer",
    });

    const response = await value.service.execute({
      type: "chat.turn.start",
      paneId: pane.id,
      expectedRevision: pane.revision,
      turnId: TURN_ONE,
      prompt: "Continue the actor.",
    });
    expect(response).toMatchObject({ type: "pane", pane: { state: "starting" } });
    await value.service.settled();
    expect(value.store.require(pane.id).projection).toMatchObject({
      state: "streaming",
      turn: { responseMarkdown: { tail: "Early answer" } },
    });
    expect(actors.calls).toEqual([{
      paneId: pane.id,
      chatTurnId: TURN_ONE,
      prompt: "Continue the actor.",
      createdAt: "2026-08-03T12:00:00.000Z",
    }]);
    expect(value.provider.startedThreads).toEqual([]);
    expect(value.provider.startedTurns).toEqual([]);

    await value.service.observeSessionAssistantCompletion({
      accountProfileId: ACCOUNT_ONE,
      threadId: "thread_service_observer",
      turnId: "turn_service_actor01",
      assistantItemId: ASSISTANT_ITEM,
      displayText: "Early answer",
      truncated: false,
    });
    await value.service.observeSessionLifecycle({
      accountProfileId: ACCOUNT_ONE,
      threadId: "thread_service_observer",
      turnId: "turn_service_actor01",
      status: "completed",
    });
    expect(value.store.require(pane.id).projection).toMatchObject({
      state: "ready",
      turn: { status: "completed", responseMarkdown: { tail: "Early answer" } },
    });
    expect(actors.reconcileCalls).toHaveLength(1);
    expect(roots.admissions).toEqual([]);
    expect(roots.observations).toEqual([]);
    expect(roots.settlements).toEqual([]);
  } finally {
    value.database.close();
  }
});

test("attached terminal hints remain active until actor authority exposes the exact result", async () => {
  const actors = new FakeHarnessActors();
  const value = harness(undefined, undefined, null, actors);
  try {
    const pane = attachObserver(value, "hactor_serviceobserver_pending");
    await value.service.execute({
      type: "chat.turn.start",
      paneId: pane.id,
      expectedRevision: pane.revision,
      turnId: TURN_ONE,
      prompt: "Wait for exact actor evidence.",
    });
    await value.service.settled();
    const streaming = value.store.require(pane.id).projection;

    await value.service.observeSessionLifecycle({
      accountProfileId: ACCOUNT_ONE,
      threadId: "thread_service_observer",
      turnId: "turn_service_actor01",
      status: "completed",
    });
    await value.service.settled();
    expect(value.store.require(pane.id).projection).toEqual(streaming);
    expect(actors.reconcileCalls).toHaveLength(1);

    actors.onReconcile = () => Promise.resolve({
      kind: "settled",
      actorTurnId: "hturn_service_actor01",
      outcome: "succeeded",
      responseMarkdown: "Authoritative actor result.",
    });
    await value.service.observeSessionLifecycle({
      accountProfileId: ACCOUNT_ONE,
      threadId: "thread_service_observer",
      turnId: "turn_service_actor01",
      status: "completed",
      inputTokens: 41,
      outputTokens: 17,
    });
    await value.service.settled();

    expect(actors.reconcileCalls).toHaveLength(2);
    expect(value.store.require(pane.id).projection).toMatchObject({
      state: "ready",
      turn: {
        id: TURN_ONE,
        status: "completed",
        responseMarkdown: { tail: "Authoritative actor result." },
      },
    });
    expect(value.store.handoffHistory(pane.id, false)).toEqual({
      complete: true,
      items: [
        { role: "user", text: "Wait for exact actor evidence." },
        { role: "assistant", text: "Authoritative actor result." },
      ],
    });
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM chat_turn_receipts WHERE pane_id = ?1",
    ).get(pane.id)).toEqual({ count: 1 });
  } finally {
    value.database.close();
  }
});

test("attached quota terminals never enter ordinary chat subscription failover", async () => {
  let ordinaryCandidateReads = 0;
  const actors = new FakeHarnessActors();
  actors.onReconcile = () => Promise.resolve({
    kind: "settled",
    actorTurnId: "hturn_service_actor01",
    outcome: "quotaRejected",
  });
  const value = harness(() => {
    ordinaryCandidateReads += 1;
    return [
      { id: ACCOUNT_TWO, selected: false, budget: "healthy" },
    ];
  }, undefined, null, actors);
  try {
    const pane = attachObserver(value, "hactor_serviceobserver_quota");
    await value.service.execute({
      type: "chat.turn.start",
      paneId: pane.id,
      expectedRevision: pane.revision,
      turnId: TURN_ONE,
      prompt: "Keep quota authority inside the actor.",
    });
    await value.service.settled();

    await value.service.observeSessionLifecycle({
      accountProfileId: ACCOUNT_ONE,
      threadId: "thread_service_observer",
      turnId: "turn_service_actor01",
      status: "failed",
      quotaProof: "provider_usage_limit_exceeded",
      inputTokens: 7,
      outputTokens: 0,
    });
    await value.service.settled();

    expect(actors.reconcileCalls).toHaveLength(1);
    expect(ordinaryCandidateReads).toBe(0);
    expect(value.provider.startedThreads).toEqual([]);
    expect(value.provider.startedTurns).toEqual([]);
    expect(value.store.require(pane.id).projection).toMatchObject({
      state: "attention",
      attention: {
        code: "all_accounts_exhausted",
        retryable: true,
      },
      turn: { id: TURN_ONE, status: "failed" },
    });
  } finally {
    value.database.close();
  }
});

test("closing admission prevents a late attached terminal from starting actor reconciliation", async () => {
  const actors = new FakeHarnessActors();
  const value = harness(undefined, undefined, null, actors);
  try {
    const pane = attachObserver(value, "hactor_serviceobserver_shutdown");
    await value.service.execute({
      type: "chat.turn.start",
      paneId: pane.id,
      expectedRevision: pane.revision,
      turnId: TURN_ONE,
      prompt: "Preserve the accepted actor turn during shutdown.",
    });
    await value.service.settled();
    expect(actors.calls).toHaveLength(1);

    value.service.closeAdmission();
    await value.service.observeSessionLifecycle({
      accountProfileId: ACCOUNT_ONE,
      threadId: "thread_service_observer",
      turnId: "turn_service_actor01",
      status: "completed",
      inputTokens: 9,
      outputTokens: 4,
    });
    await value.service.settled();

    expect(actors.reconcileCalls).toEqual([]);
    expect(value.provider.startedThreads).toEqual([]);
    expect(value.provider.startedTurns).toEqual([]);
    expect(value.store.require(pane.id).projection).toMatchObject({
      state: "streaming",
      turn: { id: TURN_ONE, status: "streaming" },
    });
  } finally {
    value.database.close();
  }
});

test("closing admission settles a late ordinary quota terminal without failover or continue", async () => {
  const value = harness(() => [
    { id: ACCOUNT_ONE, selected: true, budget: "healthy" },
    { id: ACCOUNT_TWO, selected: false, budget: "healthy" },
  ]);
  try {
    const pane = await createPane(value);
    await startTurn(value, pane.revision, TURN_ONE, "Finish before shutdown");
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");

    value.service.closeAdmission();
    await value.service.observeSessionLifecycle({
      ...lifecycle(started.request, started.turnId, "failed"),
      quotaProof: "provider_usage_limit_exceeded",
    });
    await value.service.settled();

    expect(value.provider.startedThreads).toHaveLength(1);
    expect(value.provider.startedTurns.map(({ request }) => request.prompt))
      .toEqual(["Finish before shutdown"]);
    expect(value.provider.injected).toEqual([]);
    expect(value.store.require(PANE).projection).toMatchObject({
      state: "attention",
      attention: { code: "all_accounts_exhausted", retryable: true },
      turn: { id: TURN_ONE, status: "failed" },
    });
  } finally {
    value.database.close();
  }
});

test("attached HITL rejection leaves cancellation and settlement to actor authority", async () => {
  const actors = new FakeHarnessActors();
  const value = harness(undefined, undefined, null, actors);
  try {
    const pane = attachObserver(value, "hactor_serviceobserver_hitl");
    await value.service.execute({
      type: "chat.turn.start",
      paneId: pane.id,
      expectedRevision: pane.revision,
      turnId: TURN_ONE,
      prompt: "Reject unexpected interaction safely.",
    });
    await value.service.settled();

    expect(await value.service.observeSessionInteractionRequest({
      accountProfileId: ACCOUNT_ONE,
      threadId: "thread_service_observer",
      turnId: "turn_service_actor01",
      request: {
        id: "interaction_actor001",
        kind: "file_change_approval",
        scope: "once",
        createdAt: 1_000,
        expiresAt: 61_000,
      },
    })).toBeTrue();
    await value.service.settled();
    expect(value.provider.interrupts).toEqual([]);
    expect(value.store.require(pane.id)).toMatchObject({
      binding: {
        accountProfileId: ACCOUNT_ONE,
        threadId: "thread_service_observer",
      },
      projection: { state: "streaming", turn: { id: TURN_ONE } },
    });

    actors.onReconcile = () => Promise.resolve({
      kind: "settled",
      actorTurnId: "hturn_service_actor01",
      outcome: "failed",
    });
    await value.service.observeSessionLifecycle({
      accountProfileId: ACCOUNT_ONE,
      threadId: "thread_service_observer",
      turnId: "turn_service_actor01",
      status: "failed",
      inputTokens: 3,
      outputTokens: 0,
    });
    await value.service.settled();
    expect(value.store.require(pane.id).projection).toMatchObject({
      state: "attention",
      attention: { code: "turn_failed", retryable: true },
      turn: { id: TURN_ONE, status: "failed" },
    });
  } finally {
    value.database.close();
  }
});

test("an already-settled actor result completes once without a duplicate provider turn", async () => {
  const actors = new FakeHarnessActors();
  actors.onStart = () => Promise.resolve({
    kind: "settled",
    actorTurnId: "hturn_service_settled01",
    outcome: "succeeded",
    responseMarkdown: "Recovered exact result.",
  });
  const value = harness(undefined, undefined, null, actors);
  try {
    const pane = attachObserver(value, "hactor_serviceobserver02");
    await value.service.execute({
      type: "chat.turn.start",
      paneId: pane.id,
      expectedRevision: pane.revision,
      turnId: TURN_ONE,
      prompt: "Recover this turn.",
    });
    await value.service.settled();
    const completed = value.store.require(pane.id).projection;
    expect(completed).toMatchObject({
      state: "ready",
      turn: {
        id: TURN_ONE,
        status: "completed",
        responseMarkdown: { tail: "Recovered exact result." },
      },
    });
    const duplicate = await value.service.execute({
      type: "chat.turn.start",
      paneId: pane.id,
      expectedRevision: completed.revision,
      turnId: TURN_ONE,
      prompt: "Recover this turn.",
    }).then(() => null, (reason: unknown) => reason);
    expect(duplicate).toMatchObject({ code: "conflict" });
    expect(actors.calls).toHaveLength(1);
    expect(value.store.handoffHistory(pane.id, false)).toEqual({
      complete: true,
      items: [
        { role: "user", text: "Recover this turn." },
        { role: "assistant", text: "Recovered exact result." },
      ],
    });
  } finally {
    value.database.close();
  }
});

test("lost actor admission responses recover automatically without a second initialize", async () => {
  const actors = new FakeHarnessActors();
  actors.onStart = () => Promise.resolve({
    kind: "recovering",
    actorTurnId: "hturn_service_recovering01",
  });
  const reconciled = deferred<void>();
  actors.onReconcile = () => {
    reconciled.resolve();
    return Promise.resolve({
      kind: "settled",
      actorTurnId: "hturn_service_recovering01",
      outcome: "succeeded",
      responseMarkdown: "Recovered without another logical turn.",
    });
  };
  const value = harness(
    undefined,
    undefined,
    null,
    actors,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => 0,
  );
  try {
    const pane = attachObserver(value, "hactor_serviceobserver_admissionloss");
    await value.service.execute({
      type: "chat.turn.start",
      paneId: pane.id,
      expectedRevision: pane.revision,
      turnId: TURN_ONE,
      prompt: "Keep this turn exact while admission reconciles.",
    });
    await withinDeadline(reconciled.promise, "automatic actor reconciliation");
    await value.service.settled();
    expect(actors.calls).toHaveLength(1);
    expect(actors.reconcileCalls).toHaveLength(1);
    expect(value.store.require(pane.id).projection).toMatchObject({
      state: "ready",
      turn: {
        id: TURN_ONE,
        status: "completed",
        responseMarkdown: { tail: "Recovered without another logical turn." },
      },
    });
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM chat_turn_receipts WHERE pane_id = ?1",
    ).get(pane.id)).toEqual({ count: 1 });
  } finally {
    value.service.closeAdmission();
    value.database.close();
  }
});

test("a hung attached actor start releases the pane tail and reconciles exactly", async () => {
  const actors = new FakeHarnessActors();
  const lateStart = deferred<Readonly<{
    kind: "accepted";
    actorTurnId: string;
    providerTurnId: string;
  }>>();
  const reconciled = deferred<void>();
  actors.onStart = () => lateStart.promise;
  actors.onReconcile = () => {
    reconciled.resolve();
    return Promise.resolve({
      kind: "settled",
      actorTurnId: "hturn_service_actor_timeout01",
      outcome: "succeeded",
      responseMarkdown: "Recovered after the bounded actor start.",
    });
  };
  const value = harness(
    undefined,
    undefined,
    null,
    actors,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => 0,
    null,
    null,
    5,
    undefined,
    5_000,
    5_000,
    5_000,
    10,
  );
  try {
    const pane = attachObserver(value, "hactor_serviceobserver_timeoutstart");
    await value.service.execute({
      type: "chat.turn.start",
      paneId: pane.id,
      expectedRevision: pane.revision,
      turnId: TURN_ONE,
      prompt: "Recover the exact attached start.",
    });
    await withinDeadline(reconciled.promise, "bounded actor-start reconciliation", 250);
    await value.service.settled();

    expect(actors.calls).toHaveLength(1);
    expect(actors.reconcileCalls).toHaveLength(1);
    expect(value.runtimeRecoveries).toEqual([{
      reason: "ambiguous_provider_effect_unfenced",
      accountProfileId: ACCOUNT_ONE,
      paneId: pane.id,
      turnId: TURN_ONE,
    }]);
    expect(value.store.require(pane.id).projection).toMatchObject({
      state: "ready",
      turn: {
        status: "completed",
        responseMarkdown: { tail: "Recovered after the bounded actor start." },
      },
    });
    lateStart.resolve({
      kind: "accepted",
      actorTurnId: "hturn_service_actor_timeout01",
      providerTurnId: "turn_service_actor_timeout01",
    });
    await Bun.sleep(0);
    expect(actors.calls).toHaveLength(1);
    expect(actors.reconcileCalls).toHaveLength(1);
  } finally {
    lateStart.resolve({
      kind: "accepted",
      actorTurnId: "hturn_service_actor_timeout01",
      providerTurnId: "turn_service_actor_timeout01",
    });
    value.service.closeAdmission();
    await value.service.settled();
    value.database.close();
  }
});

test("a hung attached reconciliation retries the same actor turn and converges", async () => {
  const actors = new FakeHarnessActors();
  const lateReconcile = deferred<Readonly<{
    kind: "recovering";
    actorTurnId: string;
  }>>();
  const reconciled = deferred<void>();
  let reconcileCalls = 0;
  actors.onStart = () => Promise.resolve({
    kind: "recovering",
    actorTurnId: "hturn_service_actor_timeout02",
  });
  actors.onReconcile = () => {
    reconcileCalls += 1;
    if (reconcileCalls === 1) return lateReconcile.promise;
    reconciled.resolve();
    return Promise.resolve({
      kind: "settled",
      actorTurnId: "hturn_service_actor_timeout02",
      outcome: "succeeded",
      responseMarkdown: "Recovered after bounded reconciliation.",
    });
  };
  const value = harness(
    undefined,
    undefined,
    null,
    actors,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => 0,
    null,
    null,
    5,
    undefined,
    5_000,
    5_000,
    5_000,
    10,
  );
  try {
    const pane = attachObserver(value, "hactor_serviceobserver_timeoutreconcile");
    await value.service.execute({
      type: "chat.turn.start",
      paneId: pane.id,
      expectedRevision: pane.revision,
      turnId: TURN_ONE,
      prompt: "Reconcile the exact attached turn.",
    });
    await withinDeadline(reconciled.promise, "bounded actor reconciliation retry", 250);
    await value.service.settled();

    expect(actors.calls).toHaveLength(1);
    expect(actors.reconcileCalls).toHaveLength(2);
    expect(value.runtimeRecoveries).toHaveLength(1);
    expect(value.store.require(pane.id).projection).toMatchObject({
      state: "ready",
      turn: {
        status: "completed",
        responseMarkdown: { tail: "Recovered after bounded reconciliation." },
      },
    });
    lateReconcile.resolve({
      kind: "recovering",
      actorTurnId: "hturn_service_actor_timeout02",
    });
    await Bun.sleep(0);
    expect(actors.reconcileCalls).toHaveLength(2);
  } finally {
    lateReconcile.resolve({
      kind: "recovering",
      actorTurnId: "hturn_service_actor_timeout02",
    });
    value.service.closeAdmission();
    await value.service.settled();
    value.database.close();
  }
});

test("an early replacement-thread event rebinds and drains through actor authority", async () => {
  const actors = new FakeHarnessActors();
  const value = harness(undefined, undefined, null, actors);
  try {
    const pane = attachObserver(value, "hactor_serviceobserver_rebind");
    actors.onRoute = (input) => {
      expect(input).toEqual({
        accountProfileId: ACCOUNT_ONE,
        threadId: "thread_service_actor_replacement",
        turnId: "turn_service_actor_replacement",
      });
      value.store.rebindAttachedHarnessSession({
        paneId: pane.id,
        binding: {
          accountProfileId: ACCOUNT_ONE,
          threadId: input.threadId,
          restartThreadId: "raw_thread_service_actor_replacement",
        },
        now: new Date("2026-08-03T12:00:00.010Z"),
      });
      return pane.id;
    };
    actors.onStart = async () => {
      await value.service.observeSessionActivity({
        accountProfileId: ACCOUNT_ONE,
        threadId: "thread_service_actor_replacement",
        turnId: "turn_service_actor_replacement",
        kind: "assistant_message_delta",
        assistantItemId: ASSISTANT_ITEM,
        displayText: "Replacement answer",
      });
      return {
        kind: "accepted",
        actorTurnId: "hturn_service_actor_replacement",
        providerTurnId: "turn_service_actor_replacement",
      };
    };

    await value.service.execute({
      type: "chat.turn.start",
      paneId: pane.id,
      expectedRevision: pane.revision,
      turnId: TURN_ONE,
      prompt: "Continue after a later account change.",
    });
    await value.service.settled();
    expect(actors.routeCalls).toHaveLength(1);
    expect(value.store.require(pane.id)).toMatchObject({
      binding: {
        accountProfileId: ACCOUNT_ONE,
        threadId: "thread_service_actor_replacement",
        restartThreadId: "raw_thread_service_actor_replacement",
      },
      projection: {
        state: "streaming",
        turn: { responseMarkdown: { tail: "Replacement answer" } },
      },
      providerTurnId: "turn_service_actor_replacement",
    });
  } finally {
    value.database.close();
  }
});

test("startup replays one preserved attached turn and restores its exact durable result", async () => {
  const actors = new FakeHarnessActors();
  actors.onStart = () => Promise.resolve({
    kind: "settled",
    actorTurnId: "hturn_service_recovered01",
    outcome: "succeeded",
    responseMarkdown: "Recovered after restart.",
  });
  const value = harness(undefined, undefined, null, actors);
  try {
    const pane = attachObserver(value, "hactor_serviceobserver_recovery");
    const begun = value.store.beginAttachedHarnessTurn({
      paneId: pane.id,
      expectedRevision: pane.revision,
      turnId: TURN_ONE,
      prompt: "Finish the preserved actor turn.",
      now: new Date("2026-08-03T12:00:00.001Z"),
    }).pane;

    expect(value.service.initialize().find(({ id }) => id === pane.id)).toEqual(begun);
    await value.service.settled();
    expect(actors.calls).toEqual([{
      paneId: pane.id,
      chatTurnId: TURN_ONE,
      prompt: "Finish the preserved actor turn.",
      createdAt: "2026-08-03T12:00:00.001Z",
    }]);
    expect(value.store.require(pane.id).projection).toMatchObject({
      state: "ready",
      turn: {
        id: TURN_ONE,
        status: "completed",
        responseMarkdown: { tail: "Recovered after restart." },
      },
    });
    expect(value.store.handoffHistory(pane.id, false)).toEqual({
      complete: true,
      items: [
        { role: "user", text: "Finish the preserved actor turn." },
        { role: "assistant", text: "Recovered after restart." },
      ],
    });
  } finally {
    value.database.close();
  }
});

test("startup actor unavailability retries exact reconciliation without another initialize", async () => {
  const actors = new FakeHarnessActors();
  actors.onStart = () => Promise.reject(new Error("actor boot dependency unavailable"));
  const reconciled = deferred<void>();
  actors.onReconcile = () => {
    reconciled.resolve();
    return Promise.resolve({
      kind: "settled",
      actorTurnId: "hturn_service_bootretry01",
      outcome: "succeeded",
      responseMarkdown: "Recovered on the automatic startup retry.",
    });
  };
  const value = harness(
    undefined,
    undefined,
    null,
    actors,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => 0,
  );
  try {
    const pane = attachObserver(value, "hactor_serviceobserver_bootretry");
    value.store.beginAttachedHarnessTurn({
      paneId: pane.id,
      expectedRevision: pane.revision,
      turnId: TURN_ONE,
      prompt: "Retain this exact startup turn.",
      now: new Date("2026-08-03T12:00:00.001Z"),
    });

    value.service.initialize();
    value.service.initialize();
    await withinDeadline(reconciled.promise, "startup actor reconciliation");
    await value.service.settled();
    expect(actors.calls).toHaveLength(1);
    expect(actors.reconcileCalls).toHaveLength(1);
    expect(value.store.require(pane.id).projection).toMatchObject({
      state: "ready",
      turn: {
        id: TURN_ONE,
        status: "completed",
        responseMarkdown: { tail: "Recovered on the automatic startup retry." },
      },
    });
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM chat_turn_receipts WHERE pane_id = ?1",
    ).get(pane.id)).toEqual({ count: 1 });
  } finally {
    value.service.closeAdmission();
    value.database.close();
  }
});

test("startup actor reconciliation keeps retrying after its backoff stage saturates", async () => {
  const actors = new FakeHarnessActors();
  actors.onStart = () => Promise.resolve({
    kind: "recovering",
    actorTurnId: "hturn_service_retrycap01",
  });
  const completed = deferred<void>();
  let reconciliations = 0;
  actors.onReconcile = () => {
    reconciliations += 1;
    if (reconciliations < 10) {
      return Promise.resolve({
        kind: "recovering",
        actorTurnId: "hturn_service_retrycap01",
      });
    }
    completed.resolve();
    return Promise.resolve({
      kind: "settled",
      actorTurnId: "hturn_service_retrycap01",
      outcome: "succeeded",
      responseMarkdown: "Recovered after the capped backoff stage.",
    });
  };
  const value = harness(
    undefined,
    undefined,
    null,
    actors,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => 0,
  );
  try {
    const pane = attachObserver(value, "hactor_serviceobserver_retrycap");
    value.store.beginAttachedHarnessTurn({
      paneId: pane.id,
      expectedRevision: pane.revision,
      turnId: TURN_ONE,
      prompt: "Retry this exact actor turn until authority converges.",
      now: new Date("2026-08-03T12:00:00.001Z"),
    });

    value.service.initialize();
    await withinDeadline(completed.promise, "saturated actor reconciliation");
    await value.service.settled();
    expect(actors.calls).toHaveLength(1);
    expect(actors.reconcileCalls).toHaveLength(10);
    expect(value.store.require(pane.id).projection).toMatchObject({
      state: "ready",
      turn: {
        id: TURN_ONE,
        status: "completed",
        responseMarkdown: { tail: "Recovered after the capped backoff stage." },
      },
    });
  } finally {
    value.service.closeAdmission();
    value.database.close();
  }
});

test("stale settlement and shutdown cancel pending attached startup retries", async () => {
  for (const disposition of ["settled", "closed"] as const) {
    const actors = new FakeHarnessActors();
    actors.onStart = () => Promise.resolve({
      kind: "recovering",
      actorTurnId: `hturn_service_retry_${disposition}`,
    });
    const value = harness(
      undefined,
      undefined,
      null,
      actors,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => 25,
    );
    try {
      const pane = attachObserver(
        value,
        `hactor_serviceobserver_retry_${disposition}`,
      );
      value.store.beginAttachedHarnessTurn({
        paneId: pane.id,
        expectedRevision: pane.revision,
        turnId: TURN_ONE,
        prompt: "Do not replay after authority is stale.",
        now: new Date("2026-08-03T12:00:00.001Z"),
      });
      value.service.initialize();
      await value.service.settled();
      expect(actors.calls).toHaveLength(1);

      if (disposition === "settled") {
        value.store.completeAttachedHarnessTurn({
          paneId: pane.id,
          turnId: TURN_ONE,
          markdown: "Settled elsewhere.",
          now: new Date("2026-08-03T12:00:00.002Z"),
        });
      } else {
        value.service.closeAdmission();
      }
      await Bun.sleep(75);
      expect(actors.reconcileCalls).toHaveLength(0);
    } finally {
      value.service.closeAdmission();
      value.database.close();
    }
  }
});

test("shutdown cancels an attached startup retry already queued behind pane work", async () => {
  const actors = new FakeHarnessActors();
  const paneTailEntered = deferred<void>();
  const releasePaneTail = deferred<void>();
  let blockPaneTail = false;
  const value = harness(
    undefined,
    undefined,
    null,
    actors,
    undefined,
    undefined,
    (pane) => {
      if (blockPaneTail && pane.turn?.tools.at(-1)?.status === "running") {
        paneTailEntered.resolve();
        return releasePaneTail.promise;
      }
      return undefined;
    },
    undefined,
    undefined,
    () => 0,
  );
  try {
    const pane = attachObserver(value, "hactor_serviceobserver_queuedshutdown");
    value.store.beginAttachedHarnessTurn({
      paneId: pane.id,
      expectedRevision: pane.revision,
      turnId: TURN_ONE,
      prompt: "Never call actor authority after shutdown.",
      now: new Date("2026-08-03T12:00:00.001Z"),
    });

    blockPaneTail = true;
    const blockingPaneWork = value.service.handleToolStarted({
      paneId: pane.id,
      turnId: TURN_ONE,
      category: "command",
    });
    await withinDeadline(paneTailEntered.promise, "blocked pane tail");
    value.service.initialize();
    value.service.closeAdmission();
    releasePaneTail.resolve();
    await blockingPaneWork;
    await value.service.settled();

    expect(actors.calls).toHaveLength(0);
    expect(actors.reconcileCalls).toHaveLength(0);
  } finally {
    releasePaneTail.resolve();
    value.service.closeAdmission();
    await value.service.settled();
    value.database.close();
  }
});

test("a failed terminal actor transition retains its exact startup retry", async () => {
  const actors = new FakeHarnessActors();
  actors.onStart = () => Promise.resolve({
    kind: "settled",
    actorTurnId: "hturn_service_attentionretry01",
    outcome: "failed",
  });
  actors.onReconcile = actors.onStart;
  const value = harness(
    undefined,
    undefined,
    null,
    actors,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => 0,
  );
  const firstTransition = deferred<void>();
  const secondTransition = deferred<void>();
  const enterAttention = value.store.enterAttention.bind(value.store);
  let transitionAttempts = 0;
  Object.defineProperty(value.store, "enterAttention", {
    configurable: true,
    value: (input: Parameters<ChatPaneStore["enterAttention"]>[0]) => {
      transitionAttempts += 1;
      if (transitionAttempts === 1) {
        firstTransition.resolve();
        throw new Error("simulated SQLite transition failure");
      }
      secondTransition.resolve();
      return enterAttention(input);
    },
  });
  try {
    const pane = attachObserver(value, "hactor_serviceobserver_attentionretry");
    value.store.beginAttachedHarnessTurn({
      paneId: pane.id,
      expectedRevision: pane.revision,
      turnId: TURN_ONE,
      prompt: "Retain retry authority until attention commits.",
      now: new Date("2026-08-03T12:00:00.001Z"),
    });

    value.service.initialize();
    await withinDeadline(firstTransition.promise, "failed actor terminal transition");
    await withinDeadline(secondTransition.promise, "retried actor terminal transition");
    await value.service.settled();

    expect(actors.calls).toHaveLength(1);
    expect(actors.reconcileCalls).toHaveLength(1);
    expect(value.store.require(pane.id).projection).toMatchObject({
      state: "attention",
      turn: { id: TURN_ONE, status: "failed" },
    });
  } finally {
    value.service.closeAdmission();
    value.database.close();
  }
});

test("definitive actor failures return the observer to a reusable attention state", async () => {
  for (const outcome of ["cancelled", "failed", "quotaRejected"] as const) {
    const actors = new FakeHarnessActors();
    let call = 0;
    actors.onStart = () => {
      call += 1;
      return call === 1
        ? Promise.resolve({
            kind: "settled" as const,
            actorTurnId: `hturn_service_${outcome}`,
            outcome,
          })
        : Promise.resolve({
            kind: "accepted" as const,
            actorTurnId: `hturn_service_${outcome}_retry`,
            providerTurnId: `turn_service_${outcome}_retry`,
          });
    };
    const value = harness(undefined, undefined, null, actors);
    try {
      const pane = attachObserver(value, `hactor_service_${outcome}`);
      await value.service.execute({
        type: "chat.turn.start",
        paneId: pane.id,
        expectedRevision: pane.revision,
        turnId: TURN_ONE,
        prompt: "First attempt.",
      });
      await value.service.settled();
      const attention = value.store.require(pane.id).projection;
      expect(attention).toMatchObject({
        state: "attention",
        attention: {
          code: outcome === "quotaRejected" ? "all_accounts_exhausted" : "turn_failed",
          retryable: true,
        },
      });
      await value.service.execute({
        type: "chat.turn.start",
        paneId: pane.id,
        expectedRevision: attention.revision,
        turnId: TURN_TWO,
        prompt: "Try the next turn.",
      });
      await value.service.settled();
      expect(value.store.require(pane.id).projection).toMatchObject({
        state: "streaming",
        turn: { id: TURN_TWO, status: "streaming" },
      });
      expect(actors.calls).toHaveLength(2);
    } finally {
      value.database.close();
    }
  }
});

test("unavailable settled content is terminal while actor bridge exceptions stay recoverable", async () => {
  for (const unavailable of ["missing-result", "bridge-error"] as const) {
    const actors = new FakeHarnessActors();
    actors.onStart = unavailable === "missing-result"
      ? () => Promise.resolve({
          kind: "settled",
          actorTurnId: "hturn_service_missingresult",
          outcome: "succeeded",
          responseMarkdown: null,
        })
      : () => Promise.reject(new Error("actor bridge unavailable"));
    const value = harness(undefined, undefined, null, actors);
    try {
      const pane = attachObserver(value, `hactor_service_${unavailable.replace("-", "")}`);
      await value.service.execute({
        type: "chat.turn.start",
        paneId: pane.id,
        expectedRevision: pane.revision,
        turnId: TURN_ONE,
        prompt: "Preserve recovery authority.",
      });
      await value.service.settled();
      const projection = value.store.require(pane.id).projection;
      expect(projection).toMatchObject(unavailable === "missing-result"
        ? {
            state: "attention",
            attention: { code: "runtime_unavailable", retryable: true },
            turn: { id: TURN_ONE, status: "failed" },
          }
        : {
            state: "starting",
            attention: null,
            turn: { id: TURN_ONE, status: "starting" },
          });
      expect(actors.calls).toHaveLength(1);
    } finally {
      value.service.closeAdmission();
      value.database.close();
    }
  }
});

test("repository reselection is pathless, revision-bound, and pristine-only", async () => {
  const value = harness();
  try {
    const created = await createPane(value);
    const selected = await value.service.execute({
      type: "chat.pane.repository.select",
      paneId: PANE,
      repositoryId: REPOSITORY_TWO,
      expectedRevision: created.revision,
    });
    if (selected.type !== "pane") throw new Error("Expected a pane response");
    expect(selected.pane).toMatchObject({
      revision: created.revision + 1,
      repository: { id: REPOSITORY_TWO, name: "Other" },
    });
    expect(value.fullPanes.at(-1)?.repository.id).toBe(REPOSITORY_TWO);

    await value.service.settled();
    const selectedReady = value.store.require(PANE).projection;
    await startTurn(value, selectedReady.revision);
    await value.service.settled();
    const active = value.store.require(PANE).projection;
    let repositoryError: unknown;
    try {
      await value.service.execute({
        type: "chat.pane.repository.select",
        paneId: PANE,
        repositoryId: REPOSITORY,
        expectedRevision: active.revision,
      });
    } catch (error: unknown) {
      repositoryError = error;
    }
    expect(repositoryError).toMatchObject({ code: "invalid_state" });
  } finally {
    value.database.close();
  }
});

test("exact item events advance durable activity and settle terminal success once", async () => {
  const value = harness();
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision, TURN_ONE, "First request");
    await value.service.settled();
    const first = value.provider.startedTurns[0];
    if (first === undefined) throw new Error("Expected a provider turn");
    const exact = {
      accountProfileId: first.request.accountProfileId,
      threadId: first.request.threadId,
      turnId: first.turnId,
    };
    await value.service.observeSessionToolItemStarted({
      ...exact,
      itemId: "item_exacttool01",
    } satisfies SessionToolItemStarted);
    await value.service.observeSessionToolItemStarted({
      ...exact,
      itemId: "item_exacttool01",
    });
    await value.service.observeSessionToolItemStarted({
      ...exact,
      itemId: "item_exacttool02",
    });
    await value.service.observeSessionReasoningCompletion({
      ...exact,
      itemId: "item_reasoning01",
    } satisfies SessionReasoningItemCompletion);
    await value.service.observeSessionReasoningCompletion({
      ...exact,
      itemId: "item_reasoning02",
    });
    await value.service.observeSessionActivity(activity(
      first.request,
      first.turnId,
      "assistant_message_delta",
      "Finished",
    ));
    await value.service.observeSessionAssistantCompletion(completion(
      first.request,
      first.turnId,
      "Finished",
    ));
    await value.service.observeSessionLifecycle(lifecycle(
      first.request,
      first.turnId,
      "completed",
    ));

    expect(value.store.require(PANE).projection.activity).toEqual({
      ordinal: 6,
      kind: "responseCompleted",
    });

    const ready = value.store.require(PANE).projection;
    await startTurn(value, ready.revision, TURN_TWO, "Second request");
    await value.service.settled();
    const second = value.provider.startedTurns[1];
    if (second === undefined) throw new Error("Expected a second provider turn");
    await value.service.observeSessionToolItemStarted({
      accountProfileId: second.request.accountProfileId,
      threadId: second.request.threadId,
      turnId: second.turnId,
      itemId: "item_exacttool03",
    });
    await value.service.observeSessionLifecycle(lifecycle(
      second.request,
      second.turnId,
      "failed",
    ));

    expect(value.store.require(PANE).projection).toMatchObject({
      state: "attention",
      activity: { ordinal: 8, kind: "toolStarted" },
      turn: { id: TURN_TWO, status: "failed" },
    });
  } finally {
    value.database.close();
  }
});

test("early exact events drain after binding while stale turn events are discarded", async () => {
  const value = harness();
  try {
    const created = await createPane(value);
    const exactTurnId = "turn_chat_exact2";
    const largeUnicode = "🙂".repeat(1_500);
    value.provider.onStartTurn = async (request) => {
      await value.service.observeSessionActivity(activity(
        request,
        "turn_chat_prior1",
        "assistant_message_delta",
        "stale output",
      ));
      await value.service.observeSessionActivity(activity(
        request,
        exactTurnId,
        "assistant_message_delta",
        largeUnicode,
      ));
      await value.service.observeSessionAssistantCompletion(completion(
        request,
        exactTurnId,
        largeUnicode,
      ));
      await value.service.observeSessionActivity(activity(
        request,
        exactTurnId,
        "tool_activity_started",
      ));
      await value.service.observeSessionActivity(activity(
        request,
        exactTurnId,
        "tool_activity_completed",
      ));
      await value.service.observeSessionLifecycle(lifecycle(request, exactTurnId, "completed"));
      return exactTurnId;
    };

    const response = await startTurn(value, created.revision);
    expect(response.revision).toBe(created.revision + 1);
    await value.service.settled();

    const pane = value.store.require(PANE).projection;
    expect(pane).toMatchObject({ state: "ready", turn: { status: "completed" } });
    expect(pane.turn?.responseMarkdown.tail).toBe(largeUnicode);
    expect(pane.turn?.responseMarkdown.tail).not.toContain("stale output");
    expect(pane.turn?.tools).toEqual([
      expect.objectContaining({ category: "other", status: "completed" }),
    ]);
    expect(value.deltas.length).toBeGreaterThan(1);
    expect(value.deltas.every(({ delta }) => Buffer.byteLength(delta) <= CHAT_MAX_DELTA_UTF8_BYTES))
      .toBeTrue();
    expect(value.deltas.map(({ startUtf8Offset }) => startUtf8Offset)).toEqual(
      value.deltas.map((_, index) => value.deltas
        .slice(0, index)
        .reduce((bytes, event) => bytes + Buffer.byteLength(event.delta), 0)),
    );
    const streamingIndex = value.panes.findIndex((candidate) => candidate.state === "streaming");
    const completedIndex = value.panes.findIndex(
      (candidate) => candidate.turn?.status === "completed",
    );
    expect(streamingIndex).toBeGreaterThanOrEqual(0);
    expect(completedIndex).toBeGreaterThan(streamingIndex);
  } finally {
    value.database.close();
  }
});

test("a large raw delta batch stays contiguous ahead of later fire-and-forget events", async () => {
  const value = harness();
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");
    const large = "🙂".repeat(1_500);
    const later = "\nlast event";

    const first = value.service.observeSessionActivity(activity(
      started.request,
      started.turnId,
      "assistant_message_delta",
      large,
    ));
    const second = value.service.observeSessionActivity(activity(
      started.request,
      started.turnId,
      "assistant_message_delta",
      later,
    ));
    const completedItem = value.service.observeSessionAssistantCompletion(completion(
      started.request,
      started.turnId,
      `${large}${later}`,
    ));
    const terminal = value.service.observeSessionLifecycle(lifecycle(
      started.request,
      started.turnId,
      "completed",
    ));
    await Promise.all([first, second, completedItem, terminal]);
    await value.service.settled();

    expect(value.deltas.map(({ delta }) => delta).join("")).toBe(`${large}${later}`);
    expect(value.deltas.at(-1)?.delta.endsWith(later)).toBeTrue();
    expect(value.deltas.map(({ startUtf8Offset }) => startUtf8Offset)).toEqual(
      value.deltas.map((_, index) => value.deltas
        .slice(0, index)
        .reduce((bytes, event) => bytes + Buffer.byteLength(event.delta), 0)),
    );
    expect(value.store.require(PANE).projection).toMatchObject({
      state: "ready",
      turn: { status: "completed", responseMarkdown: { tail: `${large}${later}` } },
    });
  } finally {
    value.database.close();
  }
});

test("a delayed prior-turn event cannot enter the next logical turn", async () => {
  const value = harness();
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const first = value.provider.startedTurns[0];
    if (first === undefined) throw new Error("Expected first provider turn");
    await value.service.observeSessionAssistantCompletion(completion(
      first.request,
      first.turnId,
      "",
    ));
    await value.service.observeSessionLifecycle(lifecycle(
      first.request,
      first.turnId,
      "completed",
    ));

    const afterFirst = value.store.require(PANE).projection;
    value.provider.onStartTurn = async (request) => {
      await value.service.observeSessionActivity(activity(
        request,
        first.turnId,
        "assistant_message_delta",
        "late prior text",
      ));
      return "turn_chat_exact3";
    };
    await startTurn(value, afterFirst.revision, TURN_TWO, "Continue cleanly");
    await value.service.settled();
    const second = value.provider.startedTurns.at(-1);
    if (second === undefined) throw new Error("Expected second provider turn");
    await value.service.observeSessionActivity(activity(
      second.request,
      second.turnId,
      "assistant_message_delta",
      "current text",
    ));

    expect(value.store.require(PANE).projection.turn?.responseMarkdown.tail).toBe("current text");
  } finally {
    value.database.close();
  }
});

test("an exact quota proof terminalizes once without account selection, history capture, or replay", async () => {
  const roots = new FakeHarnessRoots();
  const value = harness(() => [
    { id: ACCOUNT_ONE, selected: true, budget: "healthy" },
    { id: ACCOUNT_TWO, selected: false, budget: "healthy" },
  ], undefined, roots);
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision, TURN_ONE, "Original request");
    await value.service.settled();
    const first = value.provider.startedTurns[0];
    if (first === undefined) throw new Error("Expected first provider turn");
    await value.service.observeSessionActivity(activity(
      first.request,
      first.turnId,
      "assistant_message_delta",
      "Partial answer",
    ));
    await value.service.observeSessionAssistantCompletion(completion(
      first.request,
      first.turnId,
      "Partial answer",
    ));
    await value.service.observeSessionLifecycle({
      ...lifecycle(first.request, first.turnId, "failed"),
      quotaProof: "provider_usage_limit_exceeded",
    });

    expect(value.store.require(PANE).projection).toMatchObject({
      accountProfileId: ACCOUNT_ONE,
      state: "attention",
      attention: { code: "all_accounts_exhausted", retryable: true },
      turn: { continuationCount: 0, status: "failed" },
    });
    expect(value.provider.startedThreads).toHaveLength(1);
    expect(value.provider.startedTurns.map(({ request }) => request.prompt)).toEqual([
      "Original request",
    ]);
    expect(value.provider.injected).toEqual([]);
    expect(roots.admissions).toHaveLength(1);
    expect(roots.observations).toEqual([{
      ...lifecycle(first.request, first.turnId, "failed"),
      quotaProof: "provider_usage_limit_exceeded",
    }]);

    await value.service.observeSessionLifecycle({
      ...lifecycle(first.request, first.turnId, "failed"),
      quotaProof: "provider_usage_limit_exceeded",
    });
    expect(value.provider.startedTurns).toHaveLength(1);
    expect(value.provider.injected).toEqual([]);
    expect(roots.observations).toHaveLength(1);
  } finally {
    value.database.close();
  }
});

test("a quota terminal after interrupt ACK but within grace avoids account fencing", async () => {
  const roots = new FakeHarnessRoots();
  const value = harness(undefined, undefined, roots, null, null, undefined, null,
    undefined, undefined, undefined, null, null, 100);
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");
    value.provider.onInterrupt = () => Promise.resolve();

    const stopping = stopTurn(value, value.store.require(PANE).projection.revision);
    while (value.provider.interrupts.length === 0) await Promise.resolve();
    await value.service.observeSessionLifecycle({
      ...lifecycle(started.request, started.turnId, "failed"),
      quotaProof: "provider_usage_limit_exceeded",
    });
    const stopped = await withinDeadline(stopping, "quota terminal grace", 250);

    expect(stopped.state).toBe("attention");
    expect(value.provider.interrupts).toHaveLength(1);
    expect(value.containedAccounts).toEqual([]);
    expect(roots.observations).toEqual([{
      ...lifecycle(started.request, started.turnId, "failed"),
      quotaProof: "provider_usage_limit_exceeded",
    }]);
  } finally {
    await value.service.settled();
    value.database.close();
  }
});

test("positioned quota proof normalizes a proof-only failure for root settlement", async () => {
  const roots = new FakeHarnessRoots();
  let candidates: readonly ChatAccountCandidate[] = [
    { id: ACCOUNT_ONE, selected: true, budget: "healthy" },
  ];
  const value = harness(
    () => candidates,
    undefined,
    roots,
    null,
    null,
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    null,
    null,
    5,
    () => true,
  );
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");
    candidates = [
      { id: ACCOUNT_ONE, selected: true, budget: "exhausted" },
    ];

    await value.service.observeSessionLifecycle(
      lifecycle(started.request, started.turnId, "failed"),
    );
    await value.service.settled();

    expect(value.store.require(PANE).projection).toMatchObject({
      state: "attention",
      attention: { code: "all_accounts_exhausted", retryable: true },
    });
    expect(roots.observations).toEqual([{
      ...lifecycle(started.request, started.turnId, "failed"),
      quotaProof: "provider_usage_limit_exceeded",
    }]);
    expect(value.provider.startedTurns).toHaveLength(1);
  } finally {
    await value.service.settled();
    value.database.close();
  }
});

test("pre-turn routing may select an unknown budget, but quota still stops that turn", async () => {
  const value = harness(() => [
    { id: ACCOUNT_ONE, selected: true, budget: "unknown" },
    { id: ACCOUNT_TWO, selected: false, budget: "low" },
  ]);
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision, TURN_ONE, "Keep working");
    await value.service.settled();
    const first = value.provider.startedTurns[0];
    if (first === undefined) throw new Error("Expected the unmeasured account to remain usable");
    expect(first.request.accountProfileId).toBe(ACCOUNT_ONE);
    await value.service.observeSessionActivity(activity(
      first.request,
      first.turnId,
      "assistant_message_delta",
      "Partial answer",
    ));
    await value.service.observeSessionAssistantCompletion(completion(
      first.request,
      first.turnId,
      "Partial answer",
    ));
    await value.service.observeSessionLifecycle({
      ...lifecycle(first.request, first.turnId, "failed"),
      quotaProof: "provider_usage_limit_exceeded",
    });

    expect(value.provider.startedTurns.map(({ request }) => ({
      accountProfileId: request.accountProfileId,
      prompt: request.prompt,
    }))).toEqual([
      { accountProfileId: ACCOUNT_ONE, prompt: "Keep working" },
    ]);
    expect(value.provider.injected).toEqual([]);
    expect(value.store.require(PANE).projection).toMatchObject({
      state: "attention",
      attention: { code: "all_accounts_exhausted" },
    });
  } finally {
    await value.service.settled();
    value.database.close();
  }
});

test("a quota failure never reads or reconstructs incomplete history", async () => {
  const value = harness(() => [
    { id: ACCOUNT_ONE, selected: true, budget: "healthy" },
    { id: ACCOUNT_TWO, selected: false, budget: "healthy" },
  ]);
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision, TURN_ONE, "Original request");
    await value.service.settled();
    const first = value.provider.startedTurns[0];
    if (first === undefined) throw new Error("Expected provider turn");
    await value.service.observeSessionActivity(activity(
      first.request,
      first.turnId,
      "assistant_message_delta",
      "Partial answer",
    ));
    await value.service.observeSessionAssistantCompletion(completion(
      first.request,
      first.turnId,
      "Partial answer",
    ));
    value.database.query("UPDATE chat_panes SET history_truncated = 1 WHERE pane_id = ?1")
      .run(PANE);
    await value.service.observeSessionLifecycle({
      ...lifecycle(first.request, first.turnId, "failed"),
      quotaProof: "provider_usage_limit_exceeded",
    });

    expect(value.provider.startedTurns).toHaveLength(1);
    expect(value.provider.injected).toHaveLength(0);
    expect(value.store.require(PANE)).toMatchObject({
      binding: null,
      historyTruncated: true,
      projection: {
        state: "attention",
        attention: { code: "all_accounts_exhausted", retryable: true },
      },
    });
    expect(value.store.handoffHistory(PANE, false).complete).toBeFalse();
  } finally {
    value.database.close();
  }
});

test("a retained thread stays incomplete after failed or interrupted work", async () => {
  for (const outcome of ["failed", "interrupted"] as const) {
    const value = harness(() => [
      { id: ACCOUNT_ONE, selected: true, budget: "healthy" },
      { id: ACCOUNT_TWO, selected: false, budget: "healthy" },
    ]);
    try {
      const created = await createPane(value);
      await startTurn(value, created.revision, TURN_ONE, "Unfinished request");
      await value.service.settled();
      const unfinished = value.provider.startedTurns[0];
      if (unfinished === undefined) throw new Error("Expected unfinished provider turn");
      await value.service.observeSessionLifecycle(lifecycle(
        unfinished.request,
        unfinished.turnId,
        outcome,
      ));

      const attention = value.store.require(PANE);
      expect(attention).toMatchObject({
        binding: { accountProfileId: ACCOUNT_ONE },
        historyTruncated: true,
        projection: {
          state: "attention",
          attention: { code: "turn_failed", retryable: true },
        },
      });
      expect(value.store.handoffHistory(PANE, false).complete).toBeFalse();

      await startTurn(value, attention.projection.revision, TURN_TWO, "Later request");
      await value.service.settled();
      const later = value.provider.startedTurns[1];
      if (later === undefined) throw new Error("Expected later provider turn");
      await value.service.observeSessionActivity(activity(
        later.request,
        later.turnId,
        "assistant_message_delta",
        "Later answer",
      ));
      await value.service.observeSessionAssistantCompletion(completion(
        later.request,
        later.turnId,
        "Later answer",
      ));
      await value.service.observeSessionLifecycle(lifecycle(
        later.request,
        later.turnId,
        "completed",
      ));

      const ready = value.store.require(PANE);
      expect(ready.historyTruncated).toBeTrue();
      await startTurn(
        value,
        ready.projection.revision,
        "chatturn_primary03",
        "Quota request",
      );
      await value.service.settled();
      const quota = value.provider.startedTurns[2];
      if (quota === undefined) throw new Error("Expected quota provider turn");
      await value.service.observeSessionLifecycle({
        ...lifecycle(quota.request, quota.turnId, "failed"),
        quotaProof: "provider_usage_limit_exceeded",
      });

      expect(value.provider.startedTurns.map(({ request }) => request.prompt)).toEqual([
        "Unfinished request",
        "Later request",
        "Quota request",
      ]);
      expect(value.provider.startedThreads).toHaveLength(1);
      expect(value.provider.injected).toHaveLength(0);
      expect(value.store.require(PANE)).toMatchObject({
        binding: null,
        historyTruncated: true,
        projection: {
          state: "attention",
          attention: { code: "all_accounts_exhausted", retryable: true },
        },
      });
      expect(value.store.handoffHistory(PANE, false).complete).toBeFalse();
    } finally {
      value.database.close();
    }
  }
});

test("early event overflow interrupts the accepted turn before detaching it", async () => {
  const value = harness();
  try {
    const created = await createPane(value);
    value.provider.onStartTurn = async (request) => {
      for (let index = 0; index < 129; index += 1) {
        await value.service.observeSessionActivity(activity(
          request,
          "turn_chat_overflow",
          index % 2 === 0 ? "assistant_message_delta" : "reasoning_summary_delta",
          "x",
        ));
      }
      return "turn_chat_overflow";
    };
    await startTurn(value, created.revision);
    await value.service.settled();

    expect(value.provider.interrupts).toHaveLength(1);
    expect(value.provider.interrupts[0]).toMatchObject({ turnId: "turn_chat_overflow" });
    expect(value.store.require(PANE)).toMatchObject({
      binding: null,
      providerTurnId: null,
      projection: {
        state: "attention",
        attention: { code: "runtime_unavailable", retryable: true },
      },
    });
  } finally {
    value.database.close();
  }
});

test("invalid streaming text interrupts the exact accepted turn before detaching it", async () => {
  const value = harness();
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");

    await value.service.observeSessionActivity(activity(
      started.request,
      started.turnId,
      "assistant_message_delta",
      "invalid\0delta",
    ));
    await value.service.settled();

    expect(value.provider.interrupts).toHaveLength(1);
    expect(value.provider.interrupts[0]).toMatchObject({ turnId: started.turnId });
    expect(value.store.require(PANE)).toMatchObject({
      binding: null,
      providerTurnId: null,
      projection: {
        state: "attention",
        attention: { code: "runtime_unavailable", retryable: true },
      },
    });
  } finally {
    value.database.close();
  }
});

test("an exact logical-turn Stop is stale-revision tolerant, replay-safe, and reusable", async () => {
  const value = harness();
  try {
    const created = await createPane(value);
    const admitted = await startTurn(value, created.revision);
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");
    const beforeStop = value.store.require(PANE).projection;
    expect(beforeStop.revision).toBeGreaterThan(admitted.revision);

    const stopped = await stopTurn(value, admitted.revision);
    expect(value.provider.interrupts).toHaveLength(1);
    expect(value.provider.interrupts[0]).toMatchObject({
      accountProfileId: started.request.accountProfileId,
      threadId: started.request.threadId,
      turnId: started.turnId,
    });
    expect(stopped).toMatchObject({
      state: "attention",
      turn: { id: TURN_ONE, status: "failed" },
      attention: { code: "runtime_unavailable", retryable: true },
    });
    expect(value.containedAccounts).toEqual([ACCOUNT_ONE]);

    const replayed = await stopTurn(value, admitted.revision);
    expect(replayed).toMatchObject({
      state: "attention",
      turn: { id: TURN_ONE, status: "failed" },
    });
    expect(value.provider.interrupts).toHaveLength(1);
    await value.service.settled();
    const reusable = value.store.require(PANE).projection;
    expect(reusable.accountProfileId).toBeNull();
    await value.service.handleDelta({
      paneId: PANE,
      turnId: TURN_ONE,
      channel: "responseMarkdown",
      delta: "late provider output",
      assistantMessageId: ASSISTANT_ITEM,
    });
    await value.service.observeSessionLifecycle(
      lifecycle(started.request, started.turnId, "completed"),
    );
    expect(value.store.require(PANE).projection).toEqual(reusable);

    for (const command of [
      { expectedRevision: reusable.revision + 1, turnId: TURN_ONE },
      { expectedRevision: reusable.revision, turnId: TURN_TWO },
    ] as const) {
      const rejected = await stopTurn(
        value,
        command.expectedRevision,
        command.turnId,
      ).then(() => null, (error: unknown) => error);
      expect(rejected).toBeInstanceOf(Error);
    }
    expect(value.provider.interrupts).toHaveLength(1);

    const next = await startTurn(
      value,
      reusable.revision,
      TURN_TWO,
      "Continue after the explicit stop",
    );
    expect(next).toMatchObject({ state: "starting", turn: { id: TURN_TWO } });
    await value.service.settled();
    expect(value.provider.startedTurns.at(-1)?.request.prompt)
      .toBe("Continue after the explicit stop");
  } finally {
    await value.service.settled();
    value.database.close();
  }
});

test("duplicate Stop requests share one in-flight provider interrupt", async () => {
  const value = harness();
  const release = deferred<void>();
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const active = value.store.require(PANE).projection;
    value.provider.onInterrupt = () => release.promise;

    const first = stopTurn(value, active.revision);
    const duplicate = stopTurn(value, active.revision);
    await Promise.resolve();
    expect(value.provider.interrupts).toHaveLength(1);
    expect(value.store.require(PANE).projection.state).toBe("streaming");
    let settled = false;
    const draining = value.service.settled().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBeFalse();

    release.resolve();
    expect(await first).toEqual(await duplicate);
    await draining;
    expect(settled).toBeTrue();
    expect(value.provider.interrupts).toHaveLength(1);
  } finally {
    release.resolve();
    await value.service.settled();
    value.database.close();
  }
});

test("a not-applied Stop interrupt is never replayed before fencing the account", async () => {
  const roots = new FakeHarnessRoots();
  const containmentEntered = deferred<void>();
  const containmentRelease = deferred<void>();
  const value = harness(undefined, async () => {
    containmentEntered.resolve();
    await containmentRelease.promise;
  }, roots);
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const active = value.store.require(PANE).projection;
    value.provider.onInterrupt = () => Promise.reject(new ChatProviderEffectError({
      certainty: "not_applied",
      code: "runtime",
    }));

    const stopping = stopTurn(value, active.revision);
    await containmentEntered.promise;
    expect(value.provider.interrupts).toHaveLength(1);
    expect(value.containedAccounts).toEqual([ACCOUNT_ONE]);
    expect(value.store.require(PANE).projection.state).toBe("streaming");
    const overlap = await startTurn(
      value,
      active.revision,
      TURN_TWO,
      "must remain blocked",
    ).then(() => null, (error: unknown) => error);
    expect(overlap).toBeInstanceOf(Error);

    containmentRelease.resolve();
    const stopped = await stopping;
    await value.service.settled();
    expect(stopped).toMatchObject({
      state: "attention",
      attention: { code: "runtime_unavailable", retryable: true },
    });
    expect(value.store.require(PANE).projection.accountProfileId).toBeNull();
    expect(roots.settlements).toEqual([]);
    expect(roots.observations).toHaveLength(1);
    expect(roots.observations[0]).toMatchObject({
      status: "interrupted",
      turnId: value.provider.startedTurns[0]?.turnId,
    });
    expect(value.runtimeRecoveries).toEqual([]);
  } finally {
    containmentRelease.resolve();
    await value.service.settled();
    value.database.close();
  }
});

test("a provider terminal that wins the Stop race is returned without a second transition", async () => {
  const roots = new FakeHarnessRoots();
  const value = harness(undefined, undefined, roots);
  const interruptRelease = deferred<void>();
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");
    const active = value.store.require(PANE).projection;
    value.provider.onInterrupt = () => interruptRelease.promise;

    const stopping = stopTurn(value, active.revision);
    await Promise.resolve();
    await value.service.observeSessionLifecycle(
      lifecycle(started.request, started.turnId, "interrupted"),
    );
    expect(value.store.require(PANE).projection.state).toBe("streaming");
    const terminal = await withinDeadline(stopping, "ingress-owned Stop terminal", 250);
    expect(terminal).toMatchObject({ state: "attention", turn: { status: "failed" } });
    expect(value.store.require(PANE).projection).toEqual(terminal);
    expect(value.provider.interrupts).toHaveLength(1);
    expect(value.containedAccounts).toEqual([]);
    expect(roots.observations).toEqual([{
      accountProfileId: ACCOUNT_ONE,
      threadId: started.request.threadId,
      turnId: started.turnId,
      status: "interrupted",
    }]);
    interruptRelease.resolve();
  } finally {
    interruptRelease.resolve();
    await value.service.settled();
    value.database.close();
  }
});

test("an exact terminal inside Stop grace bypasses a blocked renderer and preserves a sibling", async () => {
  const roots = new FakeHarnessRoots();
  const projectionEntered = deferred<void>();
  const projectionRelease = deferred<void>();
  let blockProjection = false;
  const value = harness(
    undefined,
    undefined,
    roots,
    null,
    null,
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    async (delta) => {
      if (blockProjection && delta.paneId === PANE) {
        projectionEntered.resolve();
        await projectionRelease.promise;
      }
    },
    null,
    100,
  );
  try {
    const firstPane = await createPane(value);
    const secondPane = await createPane(value, PANE_TWO);
    await startTurn(value, firstPane.revision, TURN_ONE, "first", PANE);
    await startTurn(value, secondPane.revision, TURN_TWO, "sibling", PANE_TWO);
    await value.service.settled();
    const first = value.provider.startedTurns.find(
      ({ request }) => request.clientTurnId === TURN_ONE,
    );
    if (first === undefined) throw new Error("Expected the first provider turn");

    blockProjection = true;
    const blockedDelta = value.service.observeSessionActivity(activity(
      first.request,
      first.turnId,
      "assistant_message_delta",
      "blocked renderer delta",
    ));
    await projectionEntered.promise;
    value.provider.onInterrupt = () => Promise.resolve();
    const stopping = stopTurn(
      value,
      value.store.require(PANE).projection.revision,
    );
    while (value.provider.interrupts.length === 0) await Promise.resolve();
    await value.service.observeSessionLifecycle(
      lifecycle(first.request, first.turnId, "interrupted"),
    );

    const stopped = await withinDeadline(stopping, "renderer-independent Stop", 250);
    expect(stopped).toMatchObject({ state: "attention", turn: { status: "failed" } });
    expect(value.containedAccounts).toEqual([]);
    expect(value.store.require(PANE_TWO).projection).toMatchObject({
      state: "streaming",
      accountProfileId: ACCOUNT_ONE,
      turn: { id: TURN_TWO, status: "streaming" },
    });
    expect(roots.observations).toHaveLength(1);
    projectionRelease.resolve();
    await blockedDelta;
    await value.service.settled();
    expect(value.store.require(PANE_TWO).projection.state).toBe("streaming");
  } finally {
    projectionRelease.resolve();
    await value.service.settled();
    value.database.close();
  }
});

test("a terminal received before Stop is claimed without interrupt or sibling fencing", async () => {
  const roots = new FakeHarnessRoots();
  const projectionEntered = deferred<void>();
  const projectionRelease = deferred<void>();
  let blockProjection = false;
  const value = harness(
    undefined,
    undefined,
    roots,
    null,
    null,
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    async (delta) => {
      if (blockProjection && delta.paneId === PANE) {
        projectionEntered.resolve();
        await projectionRelease.promise;
      }
    },
    null,
    100,
  );
  try {
    const firstPane = await createPane(value);
    const secondPane = await createPane(value, PANE_TWO);
    await startTurn(value, firstPane.revision, TURN_ONE, "first", PANE);
    await startTurn(value, secondPane.revision, TURN_TWO, "sibling", PANE_TWO);
    await value.service.settled();
    const first = value.provider.startedTurns.find(
      ({ request }) => request.clientTurnId === TURN_ONE,
    );
    if (first === undefined) throw new Error("Expected the first provider turn");

    blockProjection = true;
    const blockedDelta = value.service.observeSessionActivity(activity(
      first.request,
      first.turnId,
      "assistant_message_delta",
      "block the terminal queue",
    ));
    await projectionEntered.promise;
    const terminalProjection = value.service.observeSessionLifecycle(
      lifecycle(first.request, first.turnId, "interrupted"),
    );
    await Promise.resolve();
    const stopped = await withinDeadline(
      stopTurn(value, value.store.require(PANE).projection.revision),
      "pre-received terminal Stop",
      250,
    );

    expect(stopped).toMatchObject({ state: "attention", turn: { status: "failed" } });
    expect(value.provider.interrupts).toEqual([]);
    expect(value.containedAccounts).toEqual([]);
    expect(roots.observations).toHaveLength(1);
    expect(value.store.require(PANE_TWO).projection.state).toBe("streaming");
    projectionRelease.resolve();
    await Promise.all([blockedDelta, terminalProjection]);
    await value.service.settled();
    expect(roots.observations).toHaveLength(1);
  } finally {
    projectionRelease.resolve();
    await value.service.settled();
    value.database.close();
  }
});

test("a wrong provider tuple cannot satisfy Stop grace and fences the account", async () => {
  const value = harness(undefined, undefined, null, null, null, undefined, null,
    undefined, undefined, undefined, null, null, 5);
  try {
    const firstPane = await createPane(value);
    const secondPane = await createPane(value, PANE_TWO);
    await startTurn(value, firstPane.revision, TURN_ONE, "first", PANE);
    await startTurn(value, secondPane.revision, TURN_TWO, "sibling", PANE_TWO);
    await value.service.settled();
    const first = value.provider.startedTurns.find(
      ({ request }) => request.clientTurnId === TURN_ONE,
    );
    if (first === undefined) throw new Error("Expected the first provider turn");
    value.provider.onInterrupt = () => Promise.resolve();

    const stopping = stopTurn(value, value.store.require(PANE).projection.revision);
    while (value.provider.interrupts.length === 0) await Promise.resolve();
    await value.service.observeSessionLifecycle({
      ...lifecycle(first.request, first.turnId, "interrupted"),
      turnId: "turn_chat_wrong_tuple",
    });
    const stopped = await stopping;
    await value.service.settled();

    expect(stopped).toMatchObject({
      state: "attention",
      accountProfileId: null,
      attention: { code: "runtime_unavailable" },
    });
    expect(value.containedAccounts).toEqual([ACCOUNT_ONE]);
    expect(value.store.require(PANE_TWO).projection).toMatchObject({
      state: "attention",
      accountProfileId: null,
      attention: { code: "account_unavailable" },
    });
  } finally {
    await value.service.settled();
    value.database.close();
  }
});

test("an exact terminal returns Stop before a hung interrupt RPC settles", async () => {
  const roots = new FakeHarnessRoots();
  const interruptRelease = deferred<void>();
  const value = harness(undefined, undefined, roots);
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");
    value.provider.onInterrupt = () => interruptRelease.promise;

    const stopping = stopTurn(value, value.store.require(PANE).projection.revision);
    while (value.provider.interrupts.length === 0) await Promise.resolve();
    await value.service.observeSessionLifecycle(
      lifecycle(started.request, started.turnId, "interrupted"),
    );
    const stopped = await withinDeadline(stopping, "terminal-before-ACK Stop", 250);
    expect(stopped.state).toBe("attention");
    expect(value.containedAccounts).toEqual([]);
    expect(roots.observations).toHaveLength(1);

    let didSettle = false;
    const settling = value.service.settled().then(() => { didSettle = true; });
    await Bun.sleep(0);
    expect(didSettle).toBeFalse();
    interruptRelease.resolve();
    await settling;
    expect(didSettle).toBeTrue();
  } finally {
    interruptRelease.resolve();
    await value.service.settled();
    value.database.close();
  }
});

test("a hung interrupt with no terminal reaches the bounded generation fence", async () => {
  const interruptRelease = deferred<void>();
  const value = harness(
    undefined,
    undefined,
    null,
    null,
    null,
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    null,
    null,
    5,
    undefined,
    5_000,
    10,
  );
  try {
    const firstPane = await createPane(value);
    const secondPane = await createPane(value, PANE_TWO);
    await startTurn(value, firstPane.revision, TURN_ONE, "first", PANE);
    await startTurn(value, secondPane.revision, TURN_TWO, "sibling", PANE_TWO);
    await value.service.settled();
    value.provider.onInterrupt = () => interruptRelease.promise;

    const stopped = await withinDeadline(
      stopTurn(value, value.store.require(PANE).projection.revision),
      "hung interrupt generation fence",
      250,
    );
    expect(stopped).toMatchObject({
      state: "attention",
      accountProfileId: null,
      attention: { code: "runtime_unavailable" },
    });
    expect(value.provider.interrupts).toHaveLength(1);
    expect(value.containedAccounts).toEqual([ACCOUNT_ONE]);
    expect(value.store.require(PANE_TWO).projection).toMatchObject({
      state: "attention",
      accountProfileId: null,
      attention: { code: "account_unavailable" },
    });
    const terminal = value.store.require(PANE).projection;
    interruptRelease.resolve();
    await value.service.settled();
    expect(value.store.require(PANE).projection).toEqual(terminal);
  } finally {
    interruptRelease.resolve();
    await value.service.settled();
    value.database.close();
  }
});

test("a timed-out interrupt is abandoned from shutdown settlement without losing rejection handling", async () => {
  const lateInterrupt = deferred<void>();
  const value = harness(
    undefined,
    undefined,
    null,
    null,
    null,
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    null,
    null,
    5,
    undefined,
    5_000,
    10,
  );
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    value.provider.onInterrupt = () => lateInterrupt.promise;

    await withinDeadline(
      stopTurn(value, value.store.require(PANE).projection.revision),
      "timed-out interrupt Stop",
      250,
    );
    value.service.closeAdmission();
    await withinDeadline(value.service.settled(), "shutdown after abandoned interrupt", 250);
    const terminal = value.store.require(PANE).projection;
    lateInterrupt.reject(new Error("late interrupt rejection"));
    await Bun.sleep(0);
    expect(value.store.require(PANE).projection).toEqual(terminal);
    expect(value.provider.interrupts).toHaveLength(1);
  } finally {
    value.service.closeAdmission();
    lateInterrupt.reject(new Error("late fixture cleanup rejection"));
    await Bun.sleep(0);
    value.database.close();
  }
});

test("a hung account fence poisons for recovery without detaching a healthy sibling", async () => {
  const containmentRelease = deferred<void>();
  const value = harness(
    undefined,
    () => containmentRelease.promise,
    null,
    null,
    null,
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    null,
    null,
    5,
    undefined,
    5_000,
    10,
    10,
  );
  try {
    const firstPane = await createPane(value);
    const secondPane = await createPane(value, PANE_TWO);
    await startTurn(value, firstPane.revision, TURN_ONE, "first", PANE);
    await startTurn(value, secondPane.revision, TURN_TWO, "sibling", PANE_TWO);
    await value.service.settled();
    value.provider.onInterrupt = () => Promise.resolve();

    const stopped = await withinDeadline(
      stopTurn(value, value.store.require(PANE).projection.revision),
      "hung account containment recovery",
      250,
    );
    expect(stopped).toMatchObject({
      state: "attention",
      attention: { code: "runtime_unavailable", retryable: true },
    });
    expect(value.store.require(PANE).activeTurnPoisoned).toBeTrue();
    expect(value.containedAccounts).toEqual([ACCOUNT_ONE]);
    expect(value.store.require(PANE_TWO).projection.state).toBe("streaming");
    expect(value.runtimeRecoveries).toEqual([{
      reason: "ambiguous_provider_effect_unfenced",
      accountProfileId: ACCOUNT_ONE,
      paneId: PANE,
      turnId: TURN_ONE,
    }]);
    containmentRelease.resolve();
    await value.service.settled();
    expect(value.store.require(PANE_TWO).projection.state).toBe("streaming");
  } finally {
    containmentRelease.resolve();
    await value.service.settled();
    value.database.close();
  }
});

test("awaited Stop clears its admission fence before immediate start or Retry", async () => {
  for (const mode of ["start", "retry"] as const) {
    const originalPrompt = `exact prompt for ${mode}`;
    const value = harness();
    try {
      const created = await createPane(value);
      await startTurn(value, created.revision, TURN_ONE, originalPrompt);
      await value.service.settled();
      const started = value.provider.startedTurns[0];
      if (started === undefined) throw new Error("Expected provider turn");
      value.provider.onInterrupt = () => Promise.resolve();
      const stopping = stopTurn(value, value.store.require(PANE).projection.revision);
      while (value.provider.interrupts.length === 0) await Promise.resolve();
      await value.service.observeSessionLifecycle(
        lifecycle(started.request, started.turnId, "interrupted"),
      );
      const stopped = await stopping;

      const admitted = mode === "start"
        ? await startTurn(value, stopped.revision, TURN_TWO, "immediate replacement")
        : await retryTurn(value, stopped.revision, TURN_ONE, TURN_TWO);
      expect(admitted).toMatchObject({ state: "starting", turn: { id: TURN_TWO } });
      await value.service.settled();
      expect(value.provider.startedTurns.at(-1)?.request.prompt).toBe(
        mode === "start" ? "immediate replacement" : originalPrompt,
      );
    } finally {
      await value.service.settled();
      value.database.close();
    }
  }
});

test("Stop releases a hung pre-account start while late refresh cannot launch provider work", async () => {
  const roots = new FakeHarnessRoots();
  const refreshEntered = deferred<void>();
  const oldRefresh = deferred<readonly ChatAccountCandidate[]>();
  let refreshCalls = 0;
  const value = harness(() => {
    refreshCalls += 1;
    if (refreshCalls === 1) {
      refreshEntered.resolve();
      return oldRefresh.promise;
    }
    return [{ id: ACCOUNT_ONE, selected: true, budget: "healthy" }];
  }, undefined, roots);
  try {
    const created = await createPane(value);
    const admitted = await startTurn(value, created.revision);
    await refreshEntered.promise;

    const stopped = await withinDeadline(
      stopTurn(value, admitted.revision),
      "pre-account Stop",
    );
    expect(stopped).toMatchObject({ state: "attention", turn: { id: TURN_ONE } });
    expect(value.containedAccounts).toEqual([]);
    expect(roots.settlements).toHaveLength(1);
    expect(value.provider.startedThreads).toEqual([]);

    await startTurn(value, stopped.revision, TURN_TWO, "new exact turn");
    await value.service.settled();
    expect(value.provider.startedTurns.map(({ request }) => request.clientTurnId))
      .toEqual([TURN_TWO]);

    oldRefresh.resolve([{ id: ACCOUNT_ONE, selected: true, budget: "healthy" }]);
    await Bun.sleep(0);
    expect(value.provider.startedTurns.map(({ request }) => request.clientTurnId))
      .toEqual([TURN_TWO]);
    expect(value.store.require(PANE).projection.turn?.id).toBe(TURN_TWO);
  } finally {
    oldRefresh.resolve([]);
    await Bun.sleep(0);
    value.database.close();
  }
});

test("Stop generation-fences a hung provider start and late success cannot reopen the old turn", async () => {
  const oldStartEntered = deferred<void>();
  const oldStart = deferred<string>();
  const value = harness();
  try {
    const created = await createPane(value);
    value.provider.onStartTurn = async () => {
      oldStartEntered.resolve();
      return await oldStart.promise;
    };
    const admitted = await startTurn(value, created.revision);
    await oldStartEntered.promise;

    const stopped = await withinDeadline(
      stopTurn(value, admitted.revision),
      "pre-binding Stop generation fence",
    );
    expect(value.containedAccounts).toEqual([ACCOUNT_ONE]);
    expect(stopped).toMatchObject({
      state: "attention",
      attention: { code: "runtime_unavailable", retryable: true },
    });
    await value.service.settled();
    const reusable = value.store.require(PANE).projection;
    expect(reusable.accountProfileId).toBeNull();

    value.provider.onStartTurn = null;
    await startTurn(value, reusable.revision, TURN_TWO, "new turn after fence");
    await value.service.settled();
    expect(value.store.require(PANE).projection).toMatchObject({
      state: "streaming",
      turn: { id: TURN_TWO },
    });
    oldStart.resolve("turn_chat_late_old");
    await Bun.sleep(0);
    expect(value.store.require(PANE).projection).toMatchObject({
      state: "streaming",
      turn: { id: TURN_TWO },
    });
    expect(value.provider.startedTurns.map(({ request }) => request.clientTurnId))
      .toEqual([TURN_TWO, TURN_ONE]);
  } finally {
    oldStart.resolve("turn_chat_late_old");
    await Bun.sleep(0);
    value.database.close();
  }
});

test("Stop fences the newly reserved account while an old binding survives a hung handoff", async () => {
  let candidates: readonly ChatAccountCandidate[] = [
    { id: ACCOUNT_ONE, selected: true, budget: "healthy" },
  ];
  const secondThreadEntered = deferred<void>();
  const secondThread = deferred<Readonly<{
    threadId: string;
    restartThreadId: string;
  }>>();
  const value = harness(() => candidates);
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision, TURN_ONE, "Establish account A");
    await value.service.settled();
    const first = value.provider.startedTurns[0];
    if (first === undefined) throw new Error("Expected the account A provider turn");
    await Promise.all([
      value.service.observeSessionActivity(activity(
        first.request,
        first.turnId,
        "assistant_message_delta",
        "Account A response",
      )),
      value.service.observeSessionAssistantCompletion(completion(
        first.request,
        first.turnId,
        "Account A response",
      )),
      value.service.observeSessionLifecycle(
        lifecycle(first.request, first.turnId, "completed"),
      ),
    ]);
    await value.service.settled();
    expect(value.store.require(PANE)).toMatchObject({
      binding: { accountProfileId: ACCOUNT_ONE },
      projection: { state: "ready", accountProfileId: ACCOUNT_ONE },
    });

    candidates = [
      { id: ACCOUNT_ONE, selected: true, budget: "exhausted" },
      { id: ACCOUNT_TWO, selected: false, budget: "healthy" },
    ];
    value.provider.onStartThread = async (request) => {
      if (request.accountProfileId !== ACCOUNT_TWO) {
        throw new Error("Only the account B handoff may reach this fixture");
      }
      secondThreadEntered.resolve();
      return await secondThread.promise;
    };
    const admitted = await startTurn(
      value,
      value.store.require(PANE).projection.revision,
      TURN_TWO,
      "Handoff to account B",
    );
    await secondThreadEntered.promise;
    expect(value.store.require(PANE)).toMatchObject({
      binding: { accountProfileId: ACCOUNT_ONE },
      projection: {
        state: "starting",
        accountProfileId: ACCOUNT_TWO,
        turn: { id: TURN_TWO },
      },
    });

    const stopped = await withinDeadline(
      stopTurn(value, admitted.revision, TURN_TWO),
      "reserved-account handoff Stop",
    );
    expect(value.containedAccounts).toEqual([ACCOUNT_TWO]);
    expect(value.containedAccounts).not.toContain(ACCOUNT_ONE);
    expect(stopped).toMatchObject({
      state: "attention",
      accountProfileId: null,
      turn: { id: TURN_TWO, status: "failed" },
      attention: { code: "runtime_unavailable", retryable: true },
    });

    candidates = [{ id: ACCOUNT_THREE, selected: false, budget: "healthy" }];
    value.provider.onStartThread = null;
    const freshTurnId = "chatturn_primary03";
    await startTurn(
      value,
      stopped.revision,
      freshTurnId,
      "Start only after account B is fenced",
    );
    await value.service.settled();
    expect(value.runtimeRecoveries).toEqual([]);
    const reusable = value.store.require(PANE).projection;
    expect(value.provider.startedThreads.at(-1)).toMatchObject({
      accountProfileId: ACCOUNT_THREE,
    });
    expect(value.provider.startedTurns.at(-1)?.request).toMatchObject({
      accountProfileId: ACCOUNT_THREE,
      clientTurnId: freshTurnId,
    });
    expect(reusable).toMatchObject({
      state: "streaming",
      accountProfileId: ACCOUNT_THREE,
      turn: { id: freshTurnId, status: "streaming" },
    });
    secondThread.resolve({
      threadId: "thread_chat_late_account_b",
      restartThreadId: "raw_thread_chat_late_account_b",
    });
    await Bun.sleep(0);
    expect(value.store.require(PANE).projection).toEqual(reusable);
    expect(value.provider.startedTurns.map(({ request }) => request.clientTurnId))
      .toEqual([TURN_ONE, freshTurnId]);
  } finally {
    secondThread.resolve({
      threadId: "thread_chat_late_account_b",
      restartThreadId: "raw_thread_chat_late_account_b",
    });
    await Bun.sleep(0);
    value.database.close();
  }
});

test("an unfenced Stop poisons the exact turn and requests one Native recovery", async () => {
  const oldStartEntered = deferred<void>();
  const oldStart = deferred<string>();
  const value = harness(
    undefined,
    () => Promise.reject(new Error("fixture generation fence failure")),
  );
  try {
    const created = await createPane(value);
    value.provider.onStartTurn = async () => {
      oldStartEntered.resolve();
      return await oldStart.promise;
    };
    const admitted = await startTurn(value, created.revision);
    await oldStartEntered.promise;

    const poisoned = await withinDeadline(
      stopTurn(value, admitted.revision),
      "unfenced Stop recovery",
    );
    expect(poisoned).toMatchObject({
      state: "attention",
      turn: { id: TURN_ONE, status: "failed" },
      attention: { code: "runtime_unavailable", retryable: true },
    });
    expect(value.store.require(PANE).activeTurnPoisoned).toBeTrue();
    expect(value.runtimeRecoveries).toEqual([{
      reason: "ambiguous_provider_effect_unfenced",
      accountProfileId: ACCOUNT_ONE,
      paneId: PANE,
      turnId: TURN_ONE,
    }]);
    const retry = await startTurn(
      value,
      poisoned.revision,
      TURN_TWO,
      "blocked until restart",
    ).then(() => null, (error: unknown) => error);
    expect(retry).toMatchObject({ code: "invalid_state" });
    expect(value.runtimeRecoveries).toHaveLength(1);
  } finally {
    oldStart.resolve("turn_chat_late_unfenced");
    await Bun.sleep(0);
    value.database.close();
  }
});

test("a failed late root settlement poisons pre-provider Stop and requests recovery", async () => {
  const roots = new FakeHarnessRoots();
  roots.onSettle = () => {
    throw new Error("fixture root settlement failure");
  };
  const refreshEntered = deferred<void>();
  const oldRefresh = deferred<readonly ChatAccountCandidate[]>();
  const value = harness(() => {
    refreshEntered.resolve();
    return oldRefresh.promise;
  }, undefined, roots);
  try {
    const created = await createPane(value);
    const admitted = await startTurn(value, created.revision);
    await refreshEntered.promise;

    const poisoned = await withinDeadline(
      stopTurn(value, admitted.revision),
      "root-settlement recovery",
    );
    expect(poisoned).toMatchObject({
      state: "attention",
      turn: { id: TURN_ONE, status: "failed" },
      attention: { code: "runtime_unavailable", retryable: true },
    });
    expect(value.runtimeRecoveries).toEqual([{
      reason: "ambiguous_provider_effect_unfenced",
      accountProfileId: null,
      paneId: PANE,
      turnId: TURN_ONE,
    }]);
  } finally {
    oldRefresh.resolve([]);
    await Bun.sleep(0);
    value.database.close();
  }
});

test("a failed root observation requests one recovery and blocks later provider mutation", async () => {
  const roots = new FakeHarnessRoots();
  roots.onObserve = () => {
    throw new Error("fixture root observation failure");
  };
  const value = harness(undefined, undefined, roots);
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");

    await value.service.observeSessionLifecycle(
      lifecycle(started.request, started.turnId, "completed"),
    );
    await value.service.settled();
    const poisoned = value.store.require(PANE);
    expect(poisoned).toMatchObject({
      activeTurnPoisoned: true,
      projection: {
        state: "attention",
        attention: { code: "runtime_unavailable", retryable: true },
      },
    });
    expect(value.runtimeRecoveries).toEqual([{
      reason: "ambiguous_provider_effect_unfenced",
      accountProfileId: ACCOUNT_ONE,
      paneId: PANE,
      turnId: TURN_ONE,
    }]);
    const blocked = await startTurn(
      value,
      poisoned.projection.revision,
      TURN_TWO,
      "must not mutate provider",
    ).then(() => null, (error: unknown) => error);
    expect(blocked).toMatchObject({ code: "invalid_state" });
    expect(value.provider.startedTurns).toHaveLength(1);
    expect(value.runtimeRecoveries).toHaveLength(1);
  } finally {
    await value.service.settled();
    value.database.close();
  }
});

test("a failed pre-provider root settlement fences an ordinary start for recovery", async () => {
  const roots = new FakeHarnessRoots();
  roots.onSettle = () => {
    throw new Error("fixture root settlement failure");
  };
  const value = harness(() => [], undefined, roots);
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const poisoned = value.store.require(PANE);

    expect(poisoned.activeTurnPoisoned).toBeTrue();
    expect(value.provider.startedThreads).toEqual([]);
    expect(value.provider.startedTurns).toEqual([]);
    expect(value.runtimeRecoveries).toEqual([{
      reason: "ambiguous_provider_effect_unfenced",
      accountProfileId: null,
      paneId: PANE,
      turnId: TURN_ONE,
    }]);
    const blocked = await startTurn(
      value,
      poisoned.projection.revision,
      TURN_TWO,
      "must wait for restart",
    ).then(() => null, (error: unknown) => error);
    expect(blocked).toMatchObject({ code: "invalid_state" });
    expect(value.runtimeRecoveries).toHaveLength(1);
  } finally {
    await value.service.settled();
    value.database.close();
  }
});

test("a failed pre-provider root settlement fences prompt-free Retry for recovery", async () => {
  const roots = new FakeHarnessRoots();
  let candidates: readonly ChatAccountCandidate[] = [
    { id: ACCOUNT_ONE, selected: true, budget: "healthy" },
  ];
  const value = harness(() => candidates, undefined, roots);
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision, TURN_ONE, "retained retry prompt");
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");
    await value.service.observeSessionLifecycle(
      lifecycle(started.request, started.turnId, "failed"),
    );
    await value.service.settled();
    const failed = value.store.require(PANE).projection;
    expect(failed).toMatchObject({ state: "attention", recoverablePrompt: true });

    candidates = [];
    roots.onSettle = () => {
      throw new Error("fixture retry root settlement failure");
    };
    await retryTurn(value, failed.revision, TURN_ONE, TURN_TWO);
    await value.service.settled();
    const poisoned = value.store.require(PANE);
    expect(poisoned.activeTurnPoisoned).toBeTrue();
    expect(value.provider.startedTurns).toHaveLength(1);
    expect(value.runtimeRecoveries).toEqual([{
      reason: "ambiguous_provider_effect_unfenced",
      accountProfileId: null,
      paneId: PANE,
      turnId: TURN_TWO,
    }]);
    const blocked = await retryTurn(
      value,
      poisoned.projection.revision,
      TURN_TWO,
      "chatturn_primary03",
    ).then(() => null, (error: unknown) => error);
    expect(blocked).toMatchObject({ code: "invalid_state" });
    expect(value.runtimeRecoveries).toHaveLength(1);
  } finally {
    await value.service.settled();
    value.database.close();
  }
});

test("a hung root observation times out to recovery without fencing a sibling account", async () => {
  const roots = new FakeHarnessRoots();
  const rootRelease = deferred<void>();
  roots.onObserve = () => rootRelease.promise;
  const value = harness(
    undefined,
    undefined,
    roots,
    null,
    null,
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    null,
    null,
    100,
    undefined,
    20,
    20,
    20,
  );
  try {
    const firstPane = await createPane(value);
    const secondPane = await createPane(value, PANE_TWO);
    await startTurn(value, firstPane.revision, TURN_ONE, "first", PANE);
    await startTurn(value, secondPane.revision, TURN_TWO, "sibling", PANE_TWO);
    await value.service.settled();
    const first = value.provider.startedTurns.find(
      ({ request }) => request.clientTurnId === TURN_ONE,
    );
    if (first === undefined) throw new Error("Expected provider turn");

    const terminalProjection = value.service.observeSessionLifecycle(
      lifecycle(first.request, first.turnId, "completed"),
    );
    while (roots.observations.length === 0) await Promise.resolve();
    const stopped = await withinDeadline(
      stopTurn(value, value.store.require(PANE).projection.revision),
      "hung root observation recovery",
      250,
    );

    expect(stopped).toMatchObject({
      state: "attention",
      attention: { code: "runtime_unavailable", retryable: true },
    });
    expect(value.containedAccounts).toEqual([]);
    expect(value.store.require(PANE_TWO).projection.state).toBe("streaming");
    expect(value.runtimeRecoveries).toEqual([{
      reason: "ambiguous_provider_effect_unfenced",
      accountProfileId: ACCOUNT_ONE,
      paneId: PANE,
      turnId: TURN_ONE,
    }]);
    expect(roots.observations).toHaveLength(1);
    rootRelease.resolve();
    await terminalProjection;
    await value.service.settled();
    expect(value.runtimeRecoveries).toHaveLength(1);
  } finally {
    rootRelease.resolve();
    await value.service.settled();
    value.database.close();
  }
});

test("hung pre-provider root settlement bounds ordinary start recovery", async () => {
  const roots = new FakeHarnessRoots();
  const rootRelease = deferred<void>();
  roots.onSettle = () => rootRelease.promise;
  const value = harness(
    () => [],
    undefined,
    roots,
    null,
    null,
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    null,
    null,
    5,
    undefined,
    15,
  );
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await withinDeadline(value.service.settled(), "hung start root settlement", 250);

    expect(value.store.require(PANE).activeTurnPoisoned).toBeTrue();
    expect(value.provider.startedTurns).toEqual([]);
    expect(value.runtimeRecoveries).toHaveLength(1);
    rootRelease.resolve();
  } finally {
    rootRelease.resolve();
    await value.service.settled();
    value.database.close();
  }
});

test("hung pre-provider root settlement bounds prompt-free Retry recovery", async () => {
  const roots = new FakeHarnessRoots();
  const rootRelease = deferred<void>();
  let candidates: readonly ChatAccountCandidate[] = [
    { id: ACCOUNT_ONE, selected: true, budget: "healthy" },
  ];
  const value = harness(
    () => candidates,
    undefined,
    roots,
    null,
    null,
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    null,
    null,
    5,
    undefined,
    15,
  );
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision, TURN_ONE, "retained prompt");
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");
    await value.service.observeSessionLifecycle(
      lifecycle(started.request, started.turnId, "failed"),
    );
    await value.service.settled();
    const failed = value.store.require(PANE).projection;
    candidates = [];
    roots.onSettle = () => rootRelease.promise;

    await retryTurn(value, failed.revision, TURN_ONE, TURN_TWO);
    await withinDeadline(value.service.settled(), "hung Retry root settlement", 250);
    expect(value.store.require(PANE).activeTurnPoisoned).toBeTrue();
    expect(value.provider.startedTurns).toHaveLength(1);
    expect(value.runtimeRecoveries).toHaveLength(1);
    rootRelease.resolve();
  } finally {
    rootRelease.resolve();
    await value.service.settled();
    value.database.close();
  }
});

test("prompt-free Retry survives restart, keeps prompt private, and sends exact bytes once", async () => {
  const originalPrompt = "  fix the typo in the button label 🧭  ";
  const replacementPrompt = "replacement prompt after retained failure";
  const value = harness();
  let restartedService: ChatService | null = null;
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision, TURN_ONE, originalPrompt);
    await value.service.settled();
    const first = value.provider.startedTurns[0];
    if (first === undefined) throw new Error("Expected original provider turn");
    await value.service.observeSessionLifecycle(
      lifecycle(first.request, first.turnId, "failed"),
    );
    await value.service.settled();
    const failed = value.store.require(PANE).projection;
    expect(failed).toMatchObject({ state: "attention", recoverablePrompt: true });
    expect(value.store.require(PANE).activePrompt).toBe(originalPrompt);
    expect(JSON.stringify(failed)).not.toContain(originalPrompt);
    expect(JSON.stringify(value.store.list())).not.toContain(originalPrompt);
    expect(value.rootTurnRouting.readTurnRouting(PANE, TURN_ONE)).toMatchObject({
      classificationReason: "boundedLeafCue",
      requestedProfile: "lunaMax",
      requestedServiceTier: "fast",
      selectedProfile: "lunaMax",
      selectedServiceTier: "fast",
      operationalOutcome: "failed",
    });

    value.service.closeAdmission();
    await value.service.settled();
    const restartedProvider = new FakeProvider();
    const restartedProjections: ChatPaneProjection[] = [];
    let timestamp = Date.parse("2026-08-04T12:00:00.000Z");
    restartedService = new ChatService({
      accounts: {
        containAmbiguousEffect: () => Promise.resolve(),
        refreshCandidates: () => Promise.resolve([
          { id: ACCOUNT_ONE, selected: true, budget: "healthy" },
        ]),
        hasRateLimitProofSince: () => false,
      },
      now: () => new Date(timestamp++),
      projection: {
        messageQueueChanged() {},
        paneChanged(pane) {
          restartedProjections.push(pane);
        },
        paneStateChanged(pane) {
          restartedProjections.push(pane);
        },
        paneRemoved() {},
        panesReordered() {},
        delta() {},
      },
      provider: restartedProvider,
      repositories: {
        resolve(repositoryId) {
          return Promise.resolve(repositoryId === REPOSITORY
            ? { id: REPOSITORY, name: "Example", workingDirectory: "/fixture/example" }
            : null);
        },
      },
      runtimeRecovery: { requestRecovery() {} },
      rootTurnRouting: new RootTurnRoutingSQLiteAuthorityV1(value.database),
      store: value.store,
      workspaces: value.workspaces,
    });
    const initialized = restartedService.initialize();
    await restartedService.settled();
    expect(JSON.stringify(initialized)).not.toContain(originalPrompt);
    expect(JSON.stringify(restartedProjections)).not.toContain(originalPrompt);
    expect(value.store.require(PANE).activePrompt).toBe(originalPrompt);

    const staleRevision = await restartedService.execute({
      type: "chat.turn.retry",
      paneId: PANE,
      expectedRevision: failed.revision - 1,
      priorFailedTurnId: TURN_ONE,
      turnId: TURN_TWO,
    }).then(() => null, (error: unknown) => error);
    const wrongPrior = await restartedService.execute({
      type: "chat.turn.retry",
      paneId: PANE,
      expectedRevision: failed.revision,
      priorFailedTurnId: "chatturn_wrongprior1",
      turnId: TURN_TWO,
    }).then(() => null, (error: unknown) => error);
    expect(staleRevision).toBeInstanceOf(Error);
    expect(wrongPrior).toBeInstanceOf(Error);
    expect(restartedProvider.startedTurns).toEqual([]);

    const retryCommand = {
      type: "chat.turn.retry" as const,
      paneId: PANE,
      expectedRevision: failed.revision,
      priorFailedTurnId: TURN_ONE,
      turnId: TURN_TWO,
    };
    expect(JSON.stringify(retryCommand)).not.toContain(originalPrompt);
    const retried = await restartedService.execute(retryCommand);
    if (retried.type !== "pane") throw new Error("Expected Retry pane response");
    expect(retried.pane.recoverablePrompt).toBeFalse();
    expect(JSON.stringify(retried)).not.toContain(originalPrompt);
    expect(JSON.stringify(value.store.list())).not.toContain(originalPrompt);
    expect(value.store.require(PANE).activePrompt).toBe(originalPrompt);
    await restartedService.settled();
    expect(restartedProvider.startedTurns).toHaveLength(1);
    expect(restartedProvider.startedTurns[0]?.request).toMatchObject({
      clientTurnId: TURN_TWO,
      prompt: originalPrompt,
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      serviceTier: "fast",
    });
    expect(value.rootTurnRouting.readTurnRouting(PANE, TURN_TWO)).toMatchObject({
      classificationReason: "boundedLeafCue",
      requestedProfile: "lunaMax",
      requestedServiceTier: "fast",
      selectedProfile: "lunaMax",
      selectedServiceTier: "fast",
      state: "accepted",
    });

    const duplicate = await restartedService.execute(retryCommand)
      .then(() => null, (error: unknown) => error);
    expect(duplicate).toBeInstanceOf(Error);
    expect(restartedProvider.startedTurns).toHaveLength(1);
    const retriedProviderTurn = restartedProvider.startedTurns[0];
    if (retriedProviderTurn === undefined) throw new Error("Expected retried provider turn");
    await restartedService.observeSessionAssistantCompletion(completion(
      retriedProviderTurn.request,
      retriedProviderTurn.turnId,
      "retry complete",
    ));
    await restartedService.observeSessionLifecycle(lifecycle(
      retriedProviderTurn.request,
      retriedProviderTurn.turnId,
      "completed",
    ));
    await restartedService.settled();
    expect(value.store.require(PANE).activePrompt).toBeNull();

    const retainedTurnId = "chatturn_primary03";
    await restartedService.execute({
      type: "chat.turn.start",
      paneId: PANE,
      expectedRevision: value.store.require(PANE).projection.revision,
      turnId: retainedTurnId,
      prompt: "old prompt to replace",
    });
    await restartedService.settled();
    const retainedProviderTurn = restartedProvider.startedTurns.at(-1);
    if (retainedProviderTurn === undefined) throw new Error("Expected retained provider turn");
    await restartedService.observeSessionLifecycle(lifecycle(
      retainedProviderTurn.request,
      retainedProviderTurn.turnId,
      "failed",
    ));
    await restartedService.settled();
    expect(value.store.require(PANE).activePrompt).toBe("old prompt to replace");

    const replacementTurnId = "chatturn_primary04";
    await restartedService.execute({
      type: "chat.turn.start",
      paneId: PANE,
      expectedRevision: value.store.require(PANE).projection.revision,
      turnId: replacementTurnId,
      prompt: replacementPrompt,
    });
    await restartedService.settled();
    expect(restartedProvider.startedTurns.at(-1)?.request).toMatchObject({
      clientTurnId: replacementTurnId,
      prompt: replacementPrompt,
    });
    expect(value.store.require(PANE).activePrompt).toBe(replacementPrompt);
    expect(JSON.stringify(value.store.list())).not.toContain(replacementPrompt);
  } finally {
    restartedService?.closeAdmission();
    await restartedService?.settled();
    value.database.close();
  }
});

test("HITL containment followed by Stop shares one interrupt and one exact terminal", async () => {
  const roots = new FakeHarnessRoots();
  const interruptRelease = deferred<void>();
  const value = harness(undefined, undefined, roots);
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");
    value.provider.onInterrupt = () => interruptRelease.promise;

    expect(await value.service.observeSessionInteractionRequest(
      interactionRequest(started, "interaction_chat_overlap01"),
    )).toBeTrue();
    while (value.provider.interrupts.length === 0) await Promise.resolve();
    const stopping = stopTurn(value, value.store.require(PANE).projection.revision);
    await value.service.observeSessionLifecycle(
      lifecycle(started.request, started.turnId, "interrupted"),
    );
    const stopped = await withinDeadline(stopping, "HITL-first shared Stop", 250);

    expect(stopped).toMatchObject({
      state: "attention",
      attention: { code: "approval_required", retryable: true },
    });
    expect(value.provider.interrupts).toHaveLength(1);
    expect(value.containedAccounts).toEqual([]);
    expect(roots.observations).toHaveLength(1);
    interruptRelease.resolve();
  } finally {
    interruptRelease.resolve();
    await value.service.settled();
    value.database.close();
  }
});

test("Stop followed by HITL rejection shares the existing interrupt authority", async () => {
  const roots = new FakeHarnessRoots();
  const interruptRelease = deferred<void>();
  const value = harness(undefined, undefined, roots);
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");
    value.provider.onInterrupt = () => interruptRelease.promise;

    const stopping = stopTurn(value, value.store.require(PANE).projection.revision);
    while (value.provider.interrupts.length === 0) await Promise.resolve();
    expect(await withinDeadline(
      value.service.observeSessionInteractionRequest(
        interactionRequest(started, "interaction_chat_overlap02"),
      ),
      "Stop-owned HITL rejection",
      250,
    )).toBeTrue();
    expect(value.provider.interrupts).toHaveLength(1);
    await value.service.observeSessionLifecycle(
      lifecycle(started.request, started.turnId, "interrupted"),
    );
    const stopped = await withinDeadline(stopping, "Stop-first shared terminal", 250);

    expect(stopped).toMatchObject({
      state: "attention",
      attention: { code: "turn_failed", retryable: true },
    });
    expect(value.provider.interrupts).toHaveLength(1);
    expect(value.containedAccounts).toEqual([]);
    expect(roots.observations).toHaveLength(1);
    interruptRelease.resolve();
  } finally {
    interruptRelease.resolve();
    await value.service.settled();
    value.database.close();
  }
});

test("HITL rejection bypasses a blocked renderer FIFO and preserves a sibling", async () => {
  const roots = new FakeHarnessRoots();
  const projectionEntered = deferred<void>();
  const projectionRelease = deferred<void>();
  let blockProjection = false;
  const value = harness(
    undefined,
    undefined,
    roots,
    null,
    null,
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    async (delta) => {
      if (blockProjection && delta.paneId === PANE) {
        projectionEntered.resolve();
        await projectionRelease.promise;
      }
    },
    null,
    100,
  );
  try {
    const firstPane = await createPane(value);
    const secondPane = await createPane(value, PANE_TWO);
    await startTurn(value, firstPane.revision, TURN_ONE, "first", PANE);
    await startTurn(value, secondPane.revision, TURN_TWO, "sibling", PANE_TWO);
    await value.service.settled();
    const first = value.provider.startedTurns.find(
      ({ request }) => request.clientTurnId === TURN_ONE,
    );
    if (first === undefined) throw new Error("Expected the first provider turn");
    blockProjection = true;
    const blockedDelta = value.service.observeSessionActivity(activity(
      first.request,
      first.turnId,
      "assistant_message_delta",
      "blocked HITL predecessor",
    ));
    await projectionEntered.promise;
    value.provider.onInterrupt = () => Promise.resolve();

    expect(await withinDeadline(
      value.service.observeSessionInteractionRequest(
        interactionRequest(first, "interaction_chat_blocked01"),
      ),
      "renderer-independent HITL rejection",
      250,
    )).toBeTrue();
    while (value.provider.interrupts.length === 0) await Promise.resolve();
    await value.service.observeSessionLifecycle(
      lifecycle(first.request, first.turnId, "interrupted"),
    );

    expect(value.provider.interrupts).toHaveLength(1);
    expect(value.containedAccounts).toEqual([]);
    expect(value.store.require(PANE_TWO).projection.state).toBe("streaming");
    projectionRelease.resolve();
    await blockedDelta;
    await value.service.settled();
    expect(value.store.require(PANE).projection).toMatchObject({
      state: "attention",
      attention: { code: "approval_required" },
    });
  } finally {
    projectionRelease.resolve();
    await value.service.settled();
    value.database.close();
  }
});

test("fresh start and Retry stay fenced until Stop finishes account detachment", async () => {
  let candidates: readonly ChatAccountCandidate[] = [
    { id: ACCOUNT_ONE, selected: true, budget: "healthy" },
  ];
  const projectionEntered = deferred<void>();
  const projectionRelease = deferred<void>();
  let blockStopProjection = false;
  const value = harness(
    () => candidates,
    undefined,
    null,
    null,
    null,
    undefined,
    async (pane) => {
      if (
        blockStopProjection &&
        pane.id === PANE &&
        pane.attention?.code === "runtime_unavailable"
      ) {
        projectionEntered.resolve();
        await projectionRelease.promise;
      }
    },
  );
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    value.provider.onInterrupt = () => Promise.resolve();
    blockStopProjection = true;
    const stopping = stopTurn(value, value.store.require(PANE).projection.revision);
    await projectionEntered.promise;
    const terminal = value.store.require(PANE).projection;
    expect(terminal).toMatchObject({ state: "attention", recoverablePrompt: true });

    const startError = await startTurn(
      value,
      terminal.revision,
      TURN_TWO,
      "must wait for detach",
    ).then(() => null, (error: unknown) => error);
    const retryError = await retryTurn(
      value,
      terminal.revision,
      TURN_ONE,
      TURN_TWO,
    ).then(() => null, (error: unknown) => error);
    expect(startError).toMatchObject({ code: "invalid_state" });
    expect(retryError).toMatchObject({ code: "invalid_state" });
    expect((startError as Error).message).toContain("still stopping");
    expect((retryError as Error).message).toContain("still stopping");
    expect(value.provider.startedTurns).toHaveLength(1);

    projectionRelease.resolve();
    const stopped = await stopping;
    await value.service.settled();
    expect(stopped.accountProfileId).toBeNull();
    candidates = [{ id: ACCOUNT_TWO, selected: false, budget: "healthy" }];
    await startTurn(value, stopped.revision, TURN_TWO, "safe replacement");
    await value.service.settled();
    expect(value.store.require(PANE).projection).toMatchObject({
      state: "streaming",
      accountProfileId: ACCOUNT_TWO,
      turn: { id: TURN_TWO },
    });
  } finally {
    projectionRelease.resolve();
    await value.service.settled();
    value.database.close();
  }
});

test("a successful HITL interrupt ACK still generation-fences before pane reuse", async () => {
  const containmentEntered = deferred<void>();
  const containmentRelease = deferred<void>();
  const value = harness(undefined, async () => {
    containmentEntered.resolve();
    await containmentRelease.promise;
  });
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");
    value.provider.onInterrupt = () => Promise.resolve();
    const request: SessionInteractionRequest = {
      accountProfileId: started.request.accountProfileId,
      threadId: started.request.threadId,
      turnId: started.turnId,
      request: {
        id: "interaction_chat001",
        kind: "file_change_approval",
        scope: "once",
        createdAt: 1_000,
        expiresAt: 61_000,
      },
    };
    expect(await value.service.observeSessionInteractionRequest(request)).toBeTrue();
    await containmentEntered.promise;
    expect(value.provider.interrupts).toHaveLength(1);
    expect(value.containedAccounts).toEqual([ACCOUNT_ONE]);
    expect(value.store.require(PANE).projection).toMatchObject({
      state: "streaming",
      turn: { status: "streaming" },
    });
    const unsafeRetry = await startTurn(
      value,
      value.store.require(PANE).projection.revision,
      TURN_TWO,
      "Too early",
    ).then(() => null, (error: unknown) => error);
    expect(unsafeRetry).toBeInstanceOf(Error);
    expect(value.provider.startedTurns).toHaveLength(1);
    expect(value.store.require(PANE).projection).toMatchObject({
      state: "streaming",
      turn: { status: "streaming" },
    });
    expect(await value.service.observeSessionInteractionRequest({
      ...request,
      threadId: "thread_unowned_1",
    })).toBeFalse();

    // Terminal proof may win while the conservative generation fence is in
    // flight, but a new message remains blocked until that fence settles.
    await value.service.observeSessionLifecycle(
      lifecycle(started.request, started.turnId, "interrupted"),
    );
    const terminal = value.store.require(PANE).projection;
    expect(terminal).toMatchObject({
      state: "attention",
      turn: { status: "failed" },
    });
    const beforeFence = await startTurn(
      value,
      terminal.revision,
      TURN_TWO,
      "Still too early after terminal proof",
    ).then(() => null, (error: unknown) => error);
    expect(beforeFence).toMatchObject({ code: "invalid_state" });

    containmentRelease.resolve();
    await value.service.settled();

    expect(value.store.require(PANE).projection.attention?.code)
      .not.toBe("approval_required");

    const attention = value.store.require(PANE).projection;
    const next = await startTurn(value, attention.revision, TURN_TWO, "Try again");
    expect(next.state).toBe("starting");
  } finally {
    containmentRelease.resolve();
    await value.service.settled();
    value.database.close();
  }
});

test("an ambiguous interrupt fences the account before any retry can overlap old work", async () => {
  const containmentEntered = deferred<void>();
  const containmentRelease = deferred<void>();
  const value = harness(undefined, async () => {
    containmentEntered.resolve();
    await containmentRelease.promise;
  });
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");
    value.provider.onInterrupt = () => Promise.reject(new ChatProviderEffectError({
      certainty: "ambiguous",
      code: "runtime",
    }));
    const request: SessionInteractionRequest = {
      accountProfileId: started.request.accountProfileId,
      threadId: started.request.threadId,
      turnId: started.turnId,
      request: {
        id: "interaction_chat002",
        kind: "file_change_approval",
        scope: "once",
        createdAt: 1_000,
        expiresAt: 61_000,
      },
    };

    expect(await value.service.observeSessionInteractionRequest(request)).toBeTrue();
    await containmentEntered.promise;
    expect(value.containedAccounts).toEqual([ACCOUNT_ONE]);
    const blocked = value.store.require(PANE).projection;
    expect(blocked.state).toBe("streaming");
    const unsafeRetry = await startTurn(
      value,
      blocked.revision,
      TURN_TWO,
      "Must not overlap",
    ).then(() => null, (error: unknown) => error);
    expect(unsafeRetry).toBeInstanceOf(Error);
    expect(value.provider.startedTurns).toHaveLength(1);

    containmentRelease.resolve();
    await value.service.settled();
    const contained = value.store.require(PANE).projection;
    expect(contained).toMatchObject({
      state: "attention",
      accountProfileId: null,
      attention: { code: "approval_required", retryable: true },
      turn: { status: "failed" },
    });
    value.provider.onInterrupt = null;
    const retry = await startTurn(
      value,
      contained.revision,
      TURN_TWO,
      "Safe after the generation fence",
    );
    expect(retry.state).toBe("starting");
    await value.service.settled();
    expect(value.provider.startedTurns.at(-1)?.request.prompt)
      .toBe("Safe after the generation fence");
    expect(value.runtimeRecoveries).toEqual([]);
  } finally {
    containmentRelease.resolve();
    await value.service.settled();
    value.database.close();
  }
});

test("an accepted provider turn is interrupted when durable acceptance fails", async () => {
  const value = harness();
  try {
    const created = await createPane(value);
    value.store.markTurnAccepted = () => {
      throw new Error("fixture store failure after acceptance");
    };
    await startTurn(value, created.revision);
    await value.service.settled();

    expect(value.provider.startedTurns).toHaveLength(1);
    expect(value.provider.interrupts).toHaveLength(1);
    expect(value.provider.interrupts[0]).toMatchObject({ turnId: "turn_chat_1" });
    expect(value.store.require(PANE)).toMatchObject({
      activeTurnPoisoned: true,
      binding: null,
      providerTurnId: null,
      projection: {
        state: "attention",
        attention: { code: "runtime_unavailable", retryable: true },
        turn: { status: "failed" },
      },
    });
    expect(value.rootTurnRouting.readTurnRouting(PANE, TURN_ONE)).toMatchObject({
      state: "terminal",
      operationalOutcome: "interrupted",
    });
    expect(value.runtimeRecoveries).toEqual([]);
  } finally {
    value.database.close();
  }
});

test("a secondary harness-settlement failure cannot reopen a contained accepted turn", async () => {
  const roots = new FakeHarnessRoots();
  const settlementAttempted = deferred<void>();
  const interruptRelease = deferred<void>();
  roots.onSettle = () => {
    settlementAttempted.resolve();
    throw new Error("fixture secondary harness settlement failure");
  };
  const value = harness(undefined, undefined, roots);
  try {
    const created = await createPane(value);
    value.provider.onInterrupt = () => interruptRelease.promise;
    value.store.markTurnAccepted = () => {
      throw new Error("fixture durable acceptance failure");
    };
    await startTurn(value, created.revision);
    await settlementAttempted.promise;

    expect(value.provider.interrupts).toHaveLength(1);
    const contained = value.store.require(PANE).projection;
    expect(contained.state).toBe("starting");
    const overlapping = await startTurn(
      value,
      contained.revision,
      TURN_TWO,
      "Must remain fenced",
    ).then(() => null, (error: unknown) => error);
    expect(overlapping).toMatchObject({ code: "invalid_state" });
    expect(value.provider.startedTurns).toHaveLength(1);

    interruptRelease.resolve();
    await value.service.settled();
    expect(value.store.require(PANE)).toMatchObject({
      activeTurnPoisoned: true,
      binding: null,
      providerTurnId: null,
      projection: {
        state: "attention",
        attention: { code: "runtime_unavailable", retryable: true },
        turn: { status: "failed" },
      },
    });
  } finally {
    interruptRelease.resolve();
    await value.service.settled();
    value.database.close();
  }
});

test("an unfenced ambiguous turn escalates once and only reopens after rehydration", async () => {
  const stalledProjection = deferred<void>();
  let blockRecoveryProjection = false;
  const value = harness(
    undefined,
    () => Promise.reject(new Error("fixture account generation fence failure")),
    null,
    null,
    null,
    undefined,
    (pane) => blockRecoveryProjection && pane.attention?.code === "runtime_unavailable"
      ? stalledProjection.promise
      : undefined,
  );
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision, TURN_ONE, "Ambiguous original mutation");
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");
    value.provider.onInterrupt = () => Promise.reject(new ChatProviderEffectError({
      certainty: "ambiguous",
      code: "runtime",
    }));
    blockRecoveryProjection = true;
    const request: SessionInteractionRequest = {
      accountProfileId: started.request.accountProfileId,
      threadId: started.request.threadId,
      turnId: started.turnId,
      request: {
        id: "interaction_chat_unfenced01",
        kind: "file_change_approval",
        scope: "once",
        createdAt: 1_000,
        expiresAt: 61_000,
      },
    };

    expect(await value.service.observeSessionInteractionRequest(request)).toBeTrue();
    await value.service.settled();

    expect(value.provider.interrupts).toHaveLength(1);
    expect(value.containedAccounts).toEqual([ACCOUNT_ONE]);
    expect(value.runtimeRecoveries).toEqual([{
      reason: "ambiguous_provider_effect_unfenced",
      accountProfileId: ACCOUNT_ONE,
      paneId: PANE,
      turnId: TURN_ONE,
    }]);
    const visible = value.store.require(PANE);
    expect(visible).toMatchObject({
      activeTurnPoisoned: true,
      binding: null,
      providerTurnId: null,
      projection: {
        state: "attention",
        attention: { code: "runtime_unavailable", retryable: true },
        turn: { id: TURN_ONE, status: "failed" },
      },
    });

    expect(await value.service.observeSessionInteractionRequest(request)).toBeFalse();
    const blocked = await startTurn(
      value,
      visible.projection.revision,
      TURN_TWO,
      "Must wait for recovery",
    ).then(() => null, (error: unknown) => error);
    expect(blocked).toMatchObject({
      name: "ChatPaneStoreError",
      code: "invalid_state",
    });
    expect((blocked as Error).message).toContain("runtime is recovering");
    expect(value.provider.startedTurns).toHaveLength(1);
    expect(value.runtimeRecoveries).toHaveLength(1);

    const restartedProvider = new FakeProvider();
    const restartedService = new ChatService({
      accounts: {
        refreshCandidates: () => Promise.resolve([
          { id: ACCOUNT_ONE, selected: true, budget: "healthy" },
        ]),
        containAmbiguousEffect: () => Promise.resolve(),
        hasRateLimitProofSince: () => false,
      },
      projection: {
        messageQueueChanged: () => undefined,
        paneChanged: () => undefined,
        paneStateChanged: () => undefined,
        paneRemoved: () => undefined,
        panesReordered: () => undefined,
        delta: () => undefined,
      },
      provider: restartedProvider,
      repositories: {
        resolve: (repositoryId) => Promise.resolve(
          repositoryId === REPOSITORY
            ? { id: REPOSITORY, name: "Example", workingDirectory: "/fixture/example" }
            : null,
        ),
      },
      runtimeRecovery: {
        requestRecovery: () => {
          throw new Error("Rehydration must not request another recovery.");
        },
      },
      rootTurnRouting: new RootTurnRoutingSQLiteAuthorityV1(value.database),
      store: value.store,
      workspaces: {
        provision: (paneId) => Promise.resolve(value.store.require(paneId).projection),
        resolve: (paneId, repository) => Promise.resolve(
          value.store.require(paneId).projection.workspace?.state === "ready"
            ? { ...repository, workingDirectory: `/fixture/managed/${paneId}` }
            : null,
        ),
        markRepositoryUnavailable: (paneId) =>
          value.workspaces.markRepositoryUnavailable(paneId),
        release: () => undefined,
      },
    });
    const rehydrated = restartedService.initialize();
    await restartedService.settled();
    expect(rehydrated).toHaveLength(1);
    expect(rehydrated[0]).toMatchObject({
      state: "attention",
      attention: { code: "runtime_unavailable", retryable: true },
    });
    expect(restartedProvider.startedTurns).toEqual([]);
    expect(restartedProvider.interrupts).toEqual([]);

    const explicitRetry = await restartedService.execute({
      type: "chat.turn.start",
      paneId: PANE,
      expectedRevision: value.store.require(PANE).projection.revision,
      turnId: TURN_TWO,
      prompt: "Explicit retry after rehydration",
    });
    expect(explicitRetry.type).toBe("pane");
    await restartedService.settled();
    expect(restartedProvider.startedTurns).toHaveLength(1);
    expect(restartedProvider.startedTurns[0]?.request.prompt)
      .toBe("Explicit retry after rehydration");
    expect(value.provider.startedTurns).toHaveLength(1);
  } finally {
    stalledProjection.resolve();
    await value.service.settled();
    value.database.close();
  }
});

test("an ambiguous turn start fences the account generation before the pane becomes reusable", async () => {
  const containmentEntered = deferred<void>();
  const containmentRelease = deferred<void>();
  const value = harness(undefined, async () => {
    containmentEntered.resolve();
    await containmentRelease.promise;
  });
  try {
    const created = await createPane(value);
    value.provider.onStartTurn = () => Promise.reject(new ChatProviderEffectError({
      certainty: "ambiguous",
      code: "runtime",
    }));
    await startTurn(value, created.revision);
    await containmentEntered.promise;

    expect(value.containedAccounts).toEqual([ACCOUNT_ONE]);
    expect(value.store.require(PANE).projection.state).toBe("starting");
    containmentRelease.resolve();
    await value.service.settled();

    const contained = value.store.require(PANE);
    expect(contained).toMatchObject({
      binding: null,
      providerTurnId: null,
      projection: {
        state: "attention",
        accountProfileId: null,
        attention: { code: "turn_failed", retryable: true },
      },
    });
    value.provider.onStartTurn = null;
    const next = await startTurn(
      value,
      contained.projection.revision,
      TURN_TWO,
      "Safe retry after containment",
    );
    expect(next.state).toBe("starting");
    await value.service.settled();
    expect(value.provider.startedTurns.at(-1)?.request.prompt).toBe("Safe retry after containment");
  } finally {
    containmentRelease.resolve();
    await value.service.settled();
    value.database.close();
  }
});

test("pre-dispatch runtime capacity leaves the pane reusable without containment", async () => {
  const value = harness();
  try {
    const created = await createPane(value);
    value.provider.onStartTurn = () => Promise.reject(new ChatProviderEffectError({
      certainty: "not_applied",
      code: "runtime",
    }));
    await startTurn(value, created.revision);
    await value.service.settled();

    expect(value.containedAccounts).toEqual([]);
    expect(value.provider.interrupts).toEqual([]);
    const reusable = value.store.require(PANE).projection;
    expect(reusable).toMatchObject({
      state: "attention",
      attention: { code: "turn_failed", retryable: true },
      turn: { status: "failed" },
    });

    value.provider.onStartTurn = null;
    const retried = await startTurn(
      value,
      reusable.revision,
      TURN_TWO,
      "Retry after local capacity",
    );
    expect(retried.state).toBe("starting");
    await value.service.settled();
    expect(value.provider.startedTurns.at(-1)?.request.prompt)
      .toBe("Retry after local capacity");
  } finally {
    await value.service.settled();
    value.database.close();
  }
});

test("an unfenced ambiguous turn start requests one recovery without deadlocking the pane", async () => {
  let providerStartAttempts = 0;
  const value = harness(
    undefined,
    () => Promise.reject(new Error("fixture account generation fence failure")),
  );
  let restartedService: ChatService | null = null;
  try {
    const created = await createPane(value);
    value.provider.onStartTurn = () => {
      providerStartAttempts += 1;
      return Promise.reject(new ChatProviderEffectError({
        certainty: "ambiguous",
        code: "runtime",
      }));
    };
    await startTurn(value, created.revision, TURN_ONE, "Ambiguous start");
    await withinDeadline(
      value.service.settled(),
      "unfenced ambiguous provider start recovery",
    );

    expect(providerStartAttempts).toBe(1);
    expect(value.provider.startedTurns).toEqual([]);
    expect(value.provider.interrupts).toEqual([]);
    expect(value.containedAccounts).toEqual([ACCOUNT_ONE]);
    expect(value.runtimeRecoveries).toEqual([{
      reason: "ambiguous_provider_effect_unfenced",
      accountProfileId: ACCOUNT_ONE,
      paneId: PANE,
      turnId: TURN_ONE,
    }]);
    const poisoned = value.store.require(PANE);
    expect(poisoned).toMatchObject({
      activeTurnPoisoned: true,
      binding: null,
      providerTurnId: null,
      projection: {
        state: "attention",
        attention: { code: "runtime_unavailable", retryable: true },
        turn: { id: TURN_ONE, status: "failed" },
      },
    });

    await withinDeadline(value.service.settled(), "idempotent recovery settlement");
    const blocked = await startTurn(
      value,
      poisoned.projection.revision,
      TURN_TWO,
      "Must wait for native recovery",
    ).then(() => null, (error: unknown) => error);
    expect(blocked).toMatchObject({
      name: "ChatPaneStoreError",
      code: "invalid_state",
    });
    expect((blocked as Error).message).toContain("runtime is recovering");
    expect(providerStartAttempts).toBe(1);
    expect(value.runtimeRecoveries).toHaveLength(1);

    value.service.closeAdmission();
    const restartedProvider = new FakeProvider();
    restartedService = new ChatService({
      accounts: {
        refreshCandidates: () => Promise.resolve([
          { id: ACCOUNT_ONE, selected: true, budget: "healthy" },
        ]),
        containAmbiguousEffect: () => Promise.resolve(),
        hasRateLimitProofSince: () => false,
      },
      projection: {
        messageQueueChanged: () => undefined,
        paneChanged: () => undefined,
        paneStateChanged: () => undefined,
        paneRemoved: () => undefined,
        panesReordered: () => undefined,
        delta: () => undefined,
      },
      provider: restartedProvider,
      repositories: {
        resolve: (repositoryId) => Promise.resolve(
          repositoryId === REPOSITORY
            ? { id: REPOSITORY, name: "Example", workingDirectory: "/fixture/example" }
            : null,
        ),
      },
      runtimeRecovery: {
        requestRecovery: () => {
          throw new Error("Rehydration must not request another recovery.");
        },
      },
      rootTurnRouting: new RootTurnRoutingSQLiteAuthorityV1(value.database),
      store: value.store,
      workspaces: value.workspaces,
    });
    const rehydrated = restartedService.initialize();
    await withinDeadline(restartedService.settled(), "recovery rehydration");
    expect(rehydrated).toHaveLength(1);
    expect(rehydrated[0]).toMatchObject({
      state: "attention",
      attention: { code: "runtime_unavailable", retryable: true },
    });
    expect(restartedProvider.startedTurns).toEqual([]);

    const retried = await restartedService.execute({
      type: "chat.turn.start",
      paneId: PANE,
      expectedRevision: value.store.require(PANE).projection.revision,
      turnId: TURN_TWO,
      prompt: "Safe retry after native recovery",
    });
    expect(retried.type).toBe("pane");
    await withinDeadline(restartedService.settled(), "post-recovery turn start");
    expect(restartedProvider.startedTurns).toHaveLength(1);
    expect(restartedProvider.startedTurns[0]?.request.prompt)
      .toBe("Safe retry after native recovery");
    expect(providerStartAttempts).toBe(1);
    expect(value.runtimeRecoveries).toHaveLength(1);
  } finally {
    value.service.closeAdmission();
    restartedService?.closeAdmission();
    value.database.close();
  }
});

test("an incomplete cross-account handoff clears context once and the next prompt starts fresh", async () => {
  let useSecondAccount = false;
  const value = harness(() => useSecondAccount
    ? [{ id: ACCOUNT_TWO, selected: true, budget: "healthy" }]
    : [{ id: ACCOUNT_ONE, selected: true, budget: "healthy" }]);
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision, TURN_ONE, "Original prompt");
    await value.service.settled();
    const first = value.provider.startedTurns[0];
    if (first === undefined) throw new Error("Expected provider turn");
    await value.service.observeSessionActivity(activity(
      first.request,
      first.turnId,
      "assistant_message_delta",
      "Original response",
    ));
    await value.service.observeSessionAssistantCompletion(completion(
      first.request,
      first.turnId,
      "Original response",
    ));
    await value.service.observeSessionLifecycle(lifecycle(
      first.request,
      first.turnId,
      "completed",
    ));
    value.database.query("UPDATE chat_panes SET history_truncated = 1 WHERE pane_id = ?1")
      .run(PANE);
    useSecondAccount = true;

    const ready = value.store.require(PANE).projection;
    await startTurn(value, ready.revision, TURN_TWO, "Unsafe transfer");
    await value.service.settled();
    const reset = value.store.require(PANE);
    expect(reset).toMatchObject({
      binding: null,
      historyTruncated: false,
      projection: {
        state: "attention",
        accountProfileId: ACCOUNT_TWO,
        attention: { code: "continuation_failed", retryable: true },
      },
    });
    expect(value.store.handoffHistory(PANE, false)).toEqual({ complete: true, items: [] });
    expect(value.provider.startedThreads).toHaveLength(1);

    await startTurn(value, reset.projection.revision, "chatturn_primary03", "Fresh prompt");
    await value.service.settled();
    expect(value.provider.startedTurns.map(({ request }) => request.prompt)).toEqual([
      "Original prompt",
      "Fresh prompt",
    ]);
    expect(value.provider.startedTurns.at(-1)?.request.accountProfileId).toBe(ACCOUNT_TWO);
    expect(value.provider.injected).toHaveLength(0);
  } finally {
    value.database.close();
  }
});

test("account unavailability detaches without a relaunch-capable provider interrupt", async () => {
  let useSecondAccount = false;
  const value = harness(() => useSecondAccount
    ? [{ id: ACCOUNT_TWO, selected: true, budget: "healthy" }]
    : [{ id: ACCOUNT_ONE, selected: true, budget: "healthy" }]);
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision, TURN_ONE, "Keep this history");
    await value.service.settled();
    const first = value.provider.startedTurns[0];
    if (first === undefined) throw new Error("Expected provider turn");
    await value.service.observeSessionActivity(activity(
      first.request,
      first.turnId,
      "assistant_message_delta",
      "Saved response",
    ));
    await value.service.observeSessionAssistantCompletion(completion(
      first.request,
      first.turnId,
      "Saved response",
    ));
    await value.service.observeSessionLifecycle(lifecycle(
      first.request,
      first.turnId,
      "completed",
    ));

    const beforeDetach = value.store.require(PANE).projection;
    await value.service.handleAccountUnavailable(ACCOUNT_ONE);
    const detached = value.store.require(PANE);
    expect(detached.projection.revision).toBe(beforeDetach.revision + 1);
    expect(detached).toMatchObject({
      binding: null,
      projection: { state: "ready", accountProfileId: null },
    });
    expect(value.store.handoffHistory(PANE, false)).toEqual({
      complete: true,
      items: [
        { role: "user", text: "Keep this history" },
        { role: "assistant", text: "Saved response" },
      ],
    });

    useSecondAccount = true;
    await startTurn(value, detached.projection.revision, TURN_TWO, "New request");
    await value.service.settled();
    expect(value.provider.injected.at(-1)?.history).toEqual([
      { role: "user", text: "Keep this history" },
      { role: "assistant", text: "Saved response" },
    ]);

    const startedThreadCount = value.provider.startedThreads.length;
    await value.service.handleAccountUnavailable(ACCOUNT_TWO);
    await value.service.settled();
    expect(value.provider.interrupts).toEqual([]);
    expect(value.provider.startedThreads).toHaveLength(startedThreadCount);
    expect(value.store.require(PANE)).toMatchObject({
      binding: null,
      providerTurnId: null,
      projection: {
        state: "attention",
        accountProfileId: null,
        attention: { code: "account_unavailable", retryable: true },
      },
    });
  } finally {
    value.database.close();
  }
});

test("authoritative completion repairs missing suffixes and zero-delta responses", async () => {
  const value = harness();
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const first = value.provider.startedTurns[0];
    if (first === undefined) throw new Error("Expected provider turn");
    await value.service.observeSessionActivity(activity(
      first.request,
      first.turnId,
      "assistant_message_delta",
      "Hello",
    ));
    await value.service.observeSessionAssistantCompletion(completion(
      first.request,
      first.turnId,
      "Hello world",
    ));
    await value.service.observeSessionLifecycle(lifecycle(first.request, first.turnId, "completed"));
    expect(value.store.require(PANE).projection.turn?.responseMarkdown.tail).toBe("Hello world");

    const ready = value.store.require(PANE).projection;
    await startTurn(value, ready.revision, TURN_TWO, "Second prompt");
    await value.service.settled();
    const second = value.provider.startedTurns.at(-1);
    if (second === undefined) throw new Error("Expected second provider turn");
    await value.service.observeSessionAssistantCompletion(completion(
      second.request,
      second.turnId,
      "No streamed deltas",
    ));
    await value.service.observeSessionLifecycle(lifecycle(
      second.request,
      second.turnId,
      "completed",
    ));
    expect(value.store.require(PANE).projection).toMatchObject({
      state: "ready",
      turn: { responseMarkdown: { tail: "No streamed deltas" }, status: "completed" },
    });
  } finally {
    value.database.close();
  }
});

test("a long completion repair emits only bounded ordered deltas", async () => {
  const value = harness();
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");
    const response = "completion-repair🙂".repeat(600);
    const deltaStart = value.deltas.length;
    const fullPaneStart = value.fullPanes.length;
    const revisionStart = value.store.require(PANE).projection.revision;

    await value.service.observeSessionAssistantCompletion(completion(
      started.request,
      started.turnId,
      response,
    ));
    await value.service.settled();

    const repairDeltas = value.deltas.slice(deltaStart);
    expect(Buffer.byteLength(response)).toBeGreaterThan(7_168);
    expect(repairDeltas.length).toBeGreaterThan(1);
    expect(repairDeltas.every(({ delta }) =>
      Buffer.byteLength(delta) <= CHAT_MAX_DELTA_UTF8_BYTES
    )).toBeTrue();
    expect(repairDeltas.map(({ revision }) => revision)).toEqual(
      repairDeltas.map((_, index) => revisionStart + index + 1),
    );
    expect(repairDeltas.map(({ startUtf8Offset }) => startUtf8Offset)).toEqual(
      repairDeltas.map((_, index) => repairDeltas
        .slice(0, index)
        .reduce((bytes, event) => bytes + Buffer.byteLength(event.delta), 0)),
    );
    expect(repairDeltas.map(({ delta }) => delta).join("")).toBe(response);
    expect(value.fullPanes).toHaveLength(fullPaneStart);
    expect(value.store.require(PANE).projection.turn?.responseMarkdown.tail).toBe(response);
  } finally {
    value.database.close();
  }
});

test("a missing-middle completion poisons the exact turn and can never send continue", async () => {
  const value = harness(() => [
    { id: ACCOUNT_ONE, selected: true, budget: "healthy" },
    { id: ACCOUNT_TWO, selected: false, budget: "healthy" },
  ]);
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");
    await value.service.observeSessionActivity(activity(
      started.request,
      started.turnId,
      "assistant_message_delta",
      "abef",
    ));
    await value.service.observeSessionAssistantCompletion(completion(
      started.request,
      started.turnId,
      "abcdef",
    ));
    await value.service.observeSessionLifecycle({
      ...lifecycle(started.request, started.turnId, "failed"),
      quotaProof: "provider_usage_limit_exceeded",
    });
    await value.service.observeSessionActivity(activity(
      started.request,
      started.turnId,
      "assistant_message_delta",
      "late",
    ));
    await value.service.settled();

    expect(value.provider.interrupts).toHaveLength(1);
    expect(value.provider.startedTurns.map(({ request }) => request.prompt)).toEqual([
      "Build the compact UI",
    ]);
    expect(value.store.require(PANE)).toMatchObject({
      activeTurnPoisoned: true,
      binding: null,
      projection: { state: "attention", attention: { code: "runtime_unavailable" } },
    });
    expect(value.store.handoffHistory(PANE, false).complete).toBeFalse();
    const poisoned = value.store.require(PANE).projection;
    await startTurn(value, poisoned.revision, TURN_TWO, "Retry from a clean context");
    await value.service.settled();
    expect(value.store.require(PANE)).toMatchObject({
      activeTurnPoisoned: false,
      historyTruncated: false,
      projection: { state: "streaming" },
    });
    expect(value.provider.startedTurns.at(-1)?.request.prompt)
      .toBe("Retry from a clean context");
  } finally {
    value.database.close();
  }
});

test("tiny adjacent deltas coalesce before durable projection without changing text", async () => {
  const value = harness();
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");
    const events = Array.from({ length: 1_000 }, () => value.service.observeSessionActivity(
      activity(started.request, started.turnId, "assistant_message_delta", "x"),
    ));
    const completedItem = value.service.observeSessionAssistantCompletion(completion(
      started.request,
      started.turnId,
      "x".repeat(1_000),
    ));
    const terminal = value.service.observeSessionLifecycle(lifecycle(
      started.request,
      started.turnId,
      "completed",
    ));
    await Promise.all([...events, completedItem, terminal]);
    await value.service.settled();

    expect(value.deltas).toHaveLength(1);
    expect(value.deltas[0]?.delta).toBe("x".repeat(1_000));
    expect(value.store.require(PANE).projection.turn?.responseMarkdown.tail)
      .toBe("x".repeat(1_000));
  } finally {
    value.database.close();
  }
});

test("shutdown admission fencing flushes an already-admitted durable delta", async () => {
  const value = harness();
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const pane = value.store.require(PANE);
    if (pane.projection.turn === null) throw new Error("Expected active chat turn");

    const admitted = value.service.handleDelta({
      paneId: PANE,
      turnId: pane.projection.turn.id,
      channel: "responseMarkdown",
      delta: "flush before shutdown",
      assistantMessageId: ASSISTANT_ITEM,
    });
    value.service.closeAdmission();
    await admitted;
    await value.service.settled();

    expect(value.store.require(PANE).projection.turn?.responseMarkdown.tail)
      .toBe("flush before shutdown");
    expect(value.deltas.at(-1)?.delta).toBe("flush before shutdown");
  } finally {
    value.database.close();
  }
});

test("64 concurrent panes share one bounded FULL stream commit", async () => {
  const value = harness();
  try {
    const paneIds = Array.from(
      { length: 64 },
      (_, index) => `pane_streambatch${String(index).padStart(2, "0")}`,
    );
    const panes: ChatPaneProjection[] = [];
    for (const paneId of paneIds) panes.push(await createPane(value, paneId));
    await Promise.all(panes.map((pane, index) => startTurn(
      value,
      pane.revision,
      `chatturn_streambatch${String(index).padStart(2, "0")}`,
      `parallel prompt ${String(index)}`,
      pane.id,
    )));
    await value.service.settled();

    const durableBatchSizes: number[] = [];
    const appendDeltaBatches = value.store.appendDeltaBatches.bind(value.store);
    value.store.appendDeltaBatches = (inputs) => {
      durableBatchSizes.push(inputs.length);
      return appendDeltaBatches(inputs);
    };
    const events = paneIds.map((paneId) => {
      const pane = value.store.require(paneId);
      const binding = pane.binding;
      if (binding === null || pane.providerTurnId === null) {
        throw new Error("Expected every parallel pane to own a provider turn");
      }
      return value.service.observeSessionActivity({
        accountProfileId: binding.accountProfileId,
        threadId: binding.threadId,
        turnId: pane.providerTurnId,
        kind: "assistant_message_delta",
        assistantItemId: ASSISTANT_ITEM,
        displayText: "durable",
      });
    });
    await Promise.all(events);
    await value.service.settled();

    expect(durableBatchSizes).toEqual([64]);
    for (const paneId of paneIds) {
      expect(value.store.require(paneId).projection.turn?.responseMarkdown.tail)
        .toBe("durable");
    }
  } finally {
    value.database.close();
  }
});

test("one rejected co-commit participant is contained without poisoning its peer", async () => {
  const value = harness();
  try {
    const first = await createPane(value, PANE);
    const second = await createPane(value, PANE_TWO);
    await Promise.all([
      startTurn(value, first.revision, TURN_ONE, "first", PANE),
      startTurn(value, second.revision, TURN_TWO, "second", PANE_TWO),
    ]);
    await value.service.settled();
    const firstPrivate = value.store.require(PANE);
    const secondPrivate = value.store.require(PANE_TWO);
    if (
      firstPrivate.binding === null || firstPrivate.providerTurnId === null ||
      secondPrivate.binding === null || secondPrivate.providerTurnId === null
    ) throw new Error("Expected both provider turns");
    value.store.appendDelta({
      paneId: PANE_TWO,
      turnId: TURN_TWO,
      channel: "responseMarkdown",
      delta: "prior",
      assistantMessageId: "item_priorassistant01",
      now: new Date("2026-08-03T12:00:01.000Z"),
    });

    await Promise.all([
      value.service.observeSessionActivity({
        accountProfileId: firstPrivate.binding.accountProfileId,
        threadId: firstPrivate.binding.threadId,
        turnId: firstPrivate.providerTurnId,
        kind: "assistant_message_delta",
        assistantItemId: ASSISTANT_ITEM,
        displayText: "healthy peer",
      }),
      value.service.observeSessionActivity({
        accountProfileId: secondPrivate.binding.accountProfileId,
        threadId: secondPrivate.binding.threadId,
        turnId: secondPrivate.providerTurnId,
        kind: "assistant_message_delta",
        assistantItemId: "item_conflicting02",
        displayText: "conflict",
      }),
    ]);
    await value.service.settled();

    expect(value.store.require(PANE)).toMatchObject({
      activeTurnPoisoned: false,
      projection: {
        state: "attention",
        attention: { code: "account_unavailable" },
        turn: { responseMarkdown: { tail: "healthy peer" } },
      },
    });
    expect(value.store.require(PANE_TWO)).toMatchObject({
      activeTurnPoisoned: true,
      projection: { state: "attention" },
    });
    expect(value.provider.interrupts).toHaveLength(1);
    expect(value.provider.interrupts[0]?.threadId).toBe(secondPrivate.binding.threadId);
    expect(value.provider.interrupts[0]?.turnId).toBe(secondPrivate.providerTurnId);
  } finally {
    value.database.close();
  }
});

test("session projection keeps FIFO barriers while one pane drain is renderer-blocked", async () => {
  const trace: string[] = [];
  const value = harness(
    undefined,
    undefined,
    null,
    null,
    null,
    undefined,
    (pane) => {
      if (pane.activity.kind === "toolStarted") trace.push("tool");
      if (pane.turn?.status === "completed") trace.push("completed");
    },
    undefined,
    undefined,
    undefined,
    (delta) => { trace.push(`delta:${delta.delta}`); },
  );
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    trace.length = 0;
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");

    const events = [
      value.service.observeSessionActivity(activity(
        started.request,
        started.turnId,
        "assistant_message_delta",
        "A",
      )),
      value.service.observeSessionToolItemStarted({
        accountProfileId: started.request.accountProfileId,
        itemId: "item_fifo_tool01",
        threadId: started.request.threadId,
        turnId: started.turnId,
      }),
      value.service.observeSessionActivity(activity(
        started.request,
        started.turnId,
        "assistant_message_delta",
        "B",
      )),
      value.service.observeSessionAssistantCompletion(completion(
        started.request,
        started.turnId,
        "AB",
      )),
      value.service.observeSessionLifecycle(lifecycle(
        started.request,
        started.turnId,
        "completed",
      )),
    ];
    await Promise.all(events);
    await value.service.settled();

    expect(trace.indexOf("delta:A")).toBeLessThan(trace.indexOf("tool"));
    expect(trace.indexOf("tool")).toBeLessThan(trace.indexOf("delta:B"));
    expect(trace.indexOf("delta:B")).toBeLessThan(trace.indexOf("completed"));
    expect(value.store.require(PANE).projection).toMatchObject({
      state: "ready",
      turn: { status: "completed", responseMarkdown: { tail: "AB" } },
    });
  } finally {
    value.database.close();
  }
});

test("a bounded pane backlog fences once, drops its suffix, and cannot stall another pane", async () => {
  const projectionEntered = deferred<void>();
  const releaseProjection = deferred<void>();
  let blockPrimary = false;
  const value = harness(
    undefined,
    undefined,
    null,
    null,
    null,
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    (delta) => {
      if (blockPrimary && delta.paneId === PANE) {
        projectionEntered.resolve();
        return releaseProjection.promise;
      }
      return undefined;
    },
  );
  try {
    const primary = await createPane(value);
    const secondary = await createPane(value, PANE_TWO);
    await startTurn(value, primary.revision);
    await startTurn(
      value,
      secondary.revision,
      "chatturn_secondary1",
      "Keep the second pane responsive",
      PANE_TWO,
    );
    await value.service.settled();
    const [first, second] = value.provider.startedTurns;
    if (first === undefined || second === undefined) throw new Error("Expected two provider turns");
    blockPrimary = true;

    void value.service.observeSessionActivity(activity(
      first.request,
      first.turnId,
      "assistant_message_delta",
      "prefix",
    )).catch(() => undefined);
    void value.service.observeSessionToolItemStarted({
      accountProfileId: first.request.accountProfileId,
      itemId: "item_backlog_barrier",
      threadId: first.request.threadId,
      turnId: first.turnId,
    }).catch(() => undefined);
    await projectionEntered.promise;

    for (let index = 0; index < 127; index += 1) {
      void value.service.observeSessionToolItemStarted({
        accountProfileId: first.request.accountProfileId,
        itemId: `item_backlog_${String(index).padStart(3, "0")}`,
        threadId: first.request.threadId,
        turnId: first.turnId,
      }).catch(() => undefined);
    }
    expect(value.provider.interrupts).toHaveLength(1);
    expect(value.provider.interrupts[0]?.turnId).toBe(first.turnId);

    await value.service.observeSessionActivity(activity(
      first.request,
      first.turnId,
      "assistant_message_delta",
      "must be ignored",
    ));
    void value.service.observeSessionLifecycle(lifecycle(
      first.request,
      first.turnId,
      "completed",
    )).catch(() => undefined);

    await withinDeadline(Promise.all([
      value.service.observeSessionActivity(activity(
        second.request,
        second.turnId,
        "assistant_message_delta",
        "second pane finished",
      )),
      value.service.observeSessionAssistantCompletion(completion(
        second.request,
        second.turnId,
        "second pane finished",
      )),
      value.service.observeSessionLifecycle(lifecycle(
        second.request,
        second.turnId,
        "completed",
      )),
    ]), "the independent pane projection");
    expect(value.store.require(PANE_TWO).projection).toMatchObject({
      state: "ready",
      turn: { status: "completed", responseMarkdown: { tail: "second pane finished" } },
    });

    value.service.closeAdmission();
    let didSettle = false;
    const settling = value.service.settled().then(() => { didSettle = true; });
    await Promise.resolve();
    expect(didSettle).toBeFalse();
    releaseProjection.resolve();
    await withinDeadline(settling, "the fenced pane drain and containment");

    expect(value.provider.interrupts).toHaveLength(1);
    expect(value.store.require(PANE)).toMatchObject({
      activeTurnPoisoned: true,
      projection: {
        state: "attention",
        attention: { code: "runtime_unavailable", retryable: true },
      },
    });
    expect(value.store.require(PANE).projection.turn?.responseMarkdown.tail)
      .toBe("prefix");
    expect(value.store.require(PANE).projection.turn?.responseMarkdown.tail)
      .not.toContain("must be ignored");
  } finally {
    releaseProjection.resolve();
    value.database.close();
  }
});

test("a terminal event that crosses the pane cap never interrupts completed provider work", async () => {
  const projectionEntered = deferred<void>();
  const releaseProjection = deferred<void>();
  const value = harness(
    undefined,
    undefined,
    null,
    null,
    null,
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    (delta) => {
      if (delta.paneId === PANE) {
        projectionEntered.resolve();
        return releaseProjection.promise;
      }
      return undefined;
    },
  );
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");

    void value.service.observeSessionActivity(activity(
      started.request,
      started.turnId,
      "assistant_message_delta",
      "terminal prefix",
    )).catch(() => undefined);
    void value.service.observeSessionToolItemStarted({
      accountProfileId: started.request.accountProfileId,
      itemId: "item_terminal_cap_barrier",
      threadId: started.request.threadId,
      turnId: started.turnId,
    }).catch(() => undefined);
    await projectionEntered.promise;
    for (let index = 0; index < 126; index += 1) {
      void value.service.observeSessionToolItemStarted({
        accountProfileId: started.request.accountProfileId,
        itemId: `item_terminal_cap_${String(index).padStart(3, "0")}`,
        threadId: started.request.threadId,
        turnId: started.turnId,
      }).catch(() => undefined);
    }

    await value.service.observeSessionLifecycle(lifecycle(
      started.request,
      started.turnId,
      "completed",
    ));
    expect(value.provider.interrupts).toEqual([]);
    expect(value.containedAccounts).toEqual([]);

    releaseProjection.resolve();
    await value.service.settled();
    expect(value.provider.interrupts).toEqual([]);
    expect(value.containedAccounts).toEqual([]);
    expect(value.store.require(PANE)).toMatchObject({
      activeTurnPoisoned: true,
      projection: { state: "attention", attention: { code: "runtime_unavailable" } },
    });
  } finally {
    releaseProjection.resolve();
    value.database.close();
  }
});

test("session projection bytes are bounded independently of entry count", async () => {
  const projectionEntered = deferred<void>();
  const releaseProjection = deferred<void>();
  const value = harness(
    undefined,
    undefined,
    null,
    null,
    null,
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    (delta) => {
      if (delta.paneId === PANE) {
        projectionEntered.resolve();
        return releaseProjection.promise;
      }
      return undefined;
    },
  );
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");
    void value.service.observeSessionActivity(activity(
      started.request,
      started.turnId,
      "assistant_message_delta",
      "x",
    )).catch(() => undefined);
    void value.service.observeSessionAssistantCompletion(completion(
      started.request,
      started.turnId,
      "a".repeat(256 * 1024),
    )).catch(() => undefined);
    await projectionEntered.promise;

    void value.service.observeSessionAssistantCompletion(completion(
      started.request,
      started.turnId,
      "b".repeat(256 * 1024),
    )).catch(() => undefined);
    await value.service.observeSessionAssistantCompletion(completion(
      started.request,
      started.turnId,
      "c".repeat(256 * 1024),
    ));
    expect(value.provider.interrupts).toHaveLength(1);

    releaseProjection.resolve();
    await value.service.settled();
    expect(value.store.require(PANE)).toMatchObject({
      activeTurnPoisoned: true,
      projection: { state: "attention" },
    });
  } finally {
    releaseProjection.resolve();
    value.database.close();
  }
});

test("in-flight renderer bytes use the per-pane reserve without poisoning a fresh pane", async () => {
  const paneIds = Array.from(
    { length: 34 },
    (_, index) => `pane_inflightbytes${String(index + 1).padStart(2, "0")}`,
  );
  const gates = new Map<string, Readonly<{
    entered: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
  }>>();
  for (const paneId of paneIds.slice(0, 33)) {
    gates.set(paneId, { entered: deferred<void>(), release: deferred<void>() });
  }
  const value = harness(
    undefined,
    undefined,
    null,
    null,
    null,
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    (delta) => {
      const gate = gates.get(delta.paneId);
      if (gate === undefined) return undefined;
      gate.entered.resolve();
      return gate.release.promise;
    },
  );
  try {
    const panes: ChatPaneProjection[] = [];
    for (const paneId of paneIds) panes.push(await createPane(value, paneId));
    for (const [index, pane] of panes.entries()) {
      await startTurn(
        value,
        pane.revision,
        `chatturn_inflight${String(index + 1).padStart(2, "0")}`,
        `In-flight byte pane ${String(index + 1)}`,
        pane.id,
      );
    }
    await value.service.settled();
    const largeCompletion = "z".repeat(256 * 1024);
    for (const [index, paneId] of paneIds.slice(0, 33).entries()) {
      const started = value.provider.startedTurns[index];
      const gate = gates.get(paneId);
      if (started === undefined || gate === undefined) throw new Error("Expected blocked pane");
      void value.service.observeSessionAssistantCompletion(completion(
        started.request,
        started.turnId,
        largeCompletion,
      )).catch(() => undefined);
      await gate.entered.promise;
    }

    const responsive = value.provider.startedTurns[33];
    if (responsive === undefined) throw new Error("Expected responsive pane");
    await withinDeadline(Promise.all([
      value.service.observeSessionActivity(activity(
        responsive.request,
        responsive.turnId,
        "assistant_message_delta",
        "fresh pane remains responsive",
      )),
      value.service.observeSessionAssistantCompletion(completion(
        responsive.request,
        responsive.turnId,
        "fresh pane remains responsive",
      )),
      value.service.observeSessionLifecycle(lifecycle(
        responsive.request,
        responsive.turnId,
        "completed",
      )),
    ]), "fresh projection beside in-flight byte reservations");
    expect(value.provider.interrupts).toEqual([]);
    expect(value.store.require(paneIds[33]!).projection).toMatchObject({
      state: "ready",
      turn: { responseMarkdown: { tail: "fresh pane remains responsive" } },
    });

    for (const gate of gates.values()) gate.release.resolve();
    await value.service.settled();
    expect(value.provider.interrupts).toEqual([]);
  } finally {
    for (const gate of gates.values()) gate.release.resolve();
    value.database.close();
  }
});

test("global projection pressure reclaims the largest stable owner across 64 live panes", async () => {
  const paneIds = Array.from(
    { length: 64 },
    (_, index) => `pane_globalqueue${String(index + 1).padStart(2, "0")}`,
  );
  const gates = new Map<string, Readonly<{
    entered: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
  }>>();
  for (const paneId of paneIds.slice(0, 4)) {
    gates.set(paneId, { entered: deferred<void>(), release: deferred<void>() });
  }
  const value = harness(
    undefined,
    undefined,
    null,
    null,
    null,
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    (delta) => {
      const gate = gates.get(delta.paneId);
      if (gate === undefined) return undefined;
      gate.entered.resolve();
      return gate.release.promise;
    },
  );
  try {
    const created: ChatPaneProjection[] = [];
    for (const paneId of paneIds) created.push(await createPane(value, paneId));
    for (const [index, pane] of created.slice(0, 5).entries()) {
      await startTurn(
        value,
        pane.revision,
        `chatturn_global${String(index + 1).padStart(2, "0")}`,
        `Global bound pane ${String(index + 1)}`,
        pane.id,
      );
    }
    await value.service.settled();
    expect(value.service.list()).toHaveLength(64);
    expect(value.provider.startedTurns).toHaveLength(5);

    for (const [paneIndex, paneId] of paneIds.slice(0, 4).entries()) {
      const started = value.provider.startedTurns[paneIndex];
      const gate = gates.get(paneId);
      if (started === undefined || gate === undefined) throw new Error("Expected blocked pane");
      void value.service.observeSessionActivity(activity(
        started.request,
        started.turnId,
        "assistant_message_delta",
        "x",
      )).catch(() => undefined);
      void value.service.observeSessionToolItemStarted({
        accountProfileId: started.request.accountProfileId,
        itemId: `item_global_barrier_${String(paneIndex)}`,
        threadId: started.request.threadId,
        turnId: started.turnId,
      }).catch(() => undefined);
      await gate.entered.promise;
      for (let eventIndex = 0; eventIndex < 126; eventIndex += 1) {
        void value.service.observeSessionToolItemStarted({
          accountProfileId: started.request.accountProfileId,
          itemId: `item_global_${String(paneIndex)}_${String(eventIndex).padStart(3, "0")}`,
          threadId: started.request.threadId,
          turnId: started.turnId,
        }).catch(() => undefined);
      }
    }
    expect(value.provider.interrupts).toHaveLength(0);

    const responsive = value.provider.startedTurns[4];
    if (responsive === undefined) throw new Error("Expected responsive pane");
    await value.service.observeSessionToolItemStarted({
      accountProfileId: responsive.request.accountProfileId,
      itemId: "item_global_overflow",
      threadId: responsive.request.threadId,
      turnId: responsive.turnId,
    });
    expect(value.provider.interrupts).toHaveLength(1);
    expect(value.provider.interrupts[0]?.turnId)
      .toBe(value.provider.startedTurns[0]?.turnId);

    await withinDeadline(Promise.all([
      value.service.observeSessionActivity(activity(
        responsive.request,
        responsive.turnId,
        "assistant_message_delta",
        "responsive pane finished",
      )),
      value.service.observeSessionAssistantCompletion(completion(
        responsive.request,
        responsive.turnId,
        "responsive pane finished",
      )),
      value.service.observeSessionLifecycle(lifecycle(
        responsive.request,
        responsive.turnId,
        "completed",
      )),
    ]), "the responsive pane behind global reclamation");
    expect(value.store.require(paneIds[4]!).projection).toMatchObject({
      state: "ready",
      turn: {
        status: "completed",
        responseMarkdown: { tail: "responsive pane finished" },
      },
    });

    for (const gate of gates.values()) gate.release.resolve();
    await value.service.settled();
    expect(value.store.require(paneIds[0]!)).toMatchObject({
      activeTurnPoisoned: true,
      projection: { state: "attention" },
    });
    for (const paneId of paneIds.slice(1, 4)) {
      expect(value.store.require(paneId)).toMatchObject({
        activeTurnPoisoned: false,
        projection: {
          state: "attention",
          attention: { code: "account_unavailable" },
        },
      });
    }
    value.service.closeAdmission();
    await value.service.settled();
  } finally {
    for (const gate of gates.values()) gate.release.resolve();
    value.database.close();
  }
});

test("global fairness reclaims an early actor buffer without poisoning actor authority", async () => {
  const actors = new FakeHarnessActors();
  const ordinaryPaneIds = Array.from(
    { length: 63 },
    (_, index) => `pane_earlyfair${String(index + 1).padStart(2, "0")}`,
  );
  const gates = new Map<string, Readonly<{
    entered: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
  }>>();
  for (const paneId of ordinaryPaneIds.slice(0, 3)) {
    gates.set(paneId, { entered: deferred<void>(), release: deferred<void>() });
  }
  const value = harness(
    undefined,
    undefined,
    null,
    actors,
    null,
    undefined,
    null,
    undefined,
    undefined,
    () => 0,
    (delta) => {
      const gate = gates.get(delta.paneId);
      if (gate === undefined) return undefined;
      gate.entered.resolve();
      return gate.release.promise;
    },
  );
  const releaseActorAcceptance = deferred<void>();
  try {
    const actorPane = attachObserver(value, "hactor_early_global_fairness");
    const ordinaryPanes: ChatPaneProjection[] = [];
    for (const paneId of ordinaryPaneIds) {
      ordinaryPanes.push(await createPane(value, paneId));
    }
    for (const [index, pane] of ordinaryPanes.slice(0, 4).entries()) {
      await startTurn(
        value,
        pane.revision,
        `chatturn_earlyfair${String(index + 1).padStart(2, "0")}`,
        `Early fairness pane ${String(index + 1)}`,
        pane.id,
      );
    }
    await value.service.settled();
    expect(value.service.list()).toHaveLength(64);

    const earlyBuffered = deferred<void>();
    actors.onStart = async () => {
      for (let index = 0; index < 128; index += 1) {
        await value.service.observeSessionToolItemStarted({
          accountProfileId: ACCOUNT_ONE,
          itemId: `item_actor_early_${String(index).padStart(3, "0")}`,
          threadId: "thread_service_observer",
          turnId: "turn_service_actor01",
        });
      }
      earlyBuffered.resolve();
      await releaseActorAcceptance.promise;
      return {
        kind: "accepted",
        actorTurnId: "hturn_service_actor01",
        providerTurnId: "turn_service_actor01",
      };
    };
    await value.service.execute({
      type: "chat.turn.start",
      paneId: actorPane.id,
      expectedRevision: actorPane.revision,
      turnId: TURN_ONE,
      prompt: "Retain the actor while early facts are pressure-reclaimed.",
    });
    await earlyBuffered.promise;

    for (const [paneIndex, paneId] of ordinaryPaneIds.slice(0, 3).entries()) {
      const started = value.provider.startedTurns[paneIndex];
      const gate = gates.get(paneId);
      if (started === undefined || gate === undefined) throw new Error("Expected stalled pane");
      void value.service.observeSessionActivity(activity(
        started.request,
        started.turnId,
        "assistant_message_delta",
        "x",
      )).catch(() => undefined);
      void value.service.observeSessionToolItemStarted({
        accountProfileId: started.request.accountProfileId,
        itemId: `item_earlyfair_barrier_${String(paneIndex)}`,
        threadId: started.request.threadId,
        turnId: started.turnId,
      }).catch(() => undefined);
      await gate.entered.promise;
      for (let eventIndex = 0; eventIndex < 126; eventIndex += 1) {
        void value.service.observeSessionToolItemStarted({
          accountProfileId: started.request.accountProfileId,
          itemId: `item_earlyfair_${String(paneIndex)}_${String(eventIndex).padStart(3, "0")}`,
          threadId: started.request.threadId,
          turnId: started.turnId,
        }).catch(() => undefined);
      }
    }

    const responsive = value.provider.startedTurns[3];
    if (responsive === undefined) throw new Error("Expected responsive pane");
    await value.service.observeSessionToolItemStarted({
      accountProfileId: responsive.request.accountProfileId,
      itemId: "item_earlyfair_responsive",
      threadId: responsive.request.threadId,
      turnId: responsive.turnId,
    });
    await withinDeadline(Promise.all([
      value.service.observeSessionActivity(activity(
        responsive.request,
        responsive.turnId,
        "assistant_message_delta",
        "responsive after early reclaim",
      )),
      value.service.observeSessionAssistantCompletion(completion(
        responsive.request,
        responsive.turnId,
        "responsive after early reclaim",
      )),
      value.service.observeSessionLifecycle(lifecycle(
        responsive.request,
        responsive.turnId,
        "completed",
      )),
    ]), "responsive projection after early actor reclamation");
    expect(value.store.require(ordinaryPaneIds[3]!).projection).toMatchObject({
      state: "ready",
      turn: { responseMarkdown: { tail: "responsive after early reclaim" } },
    });
    expect(value.provider.interrupts).toEqual([]);

    releaseActorAcceptance.resolve();
    for (const gate of gates.values()) gate.release.resolve();
    await value.service.settled();
    expect(value.provider.interrupts).toEqual([]);
    expect(value.containedAccounts).toEqual([]);
    expect(value.store.require(actorPane.id)).toMatchObject({
      activeTurnPoisoned: false,
      providerTurnId: "turn_service_actor01",
      projection: { state: "streaming", turn: { id: TURN_ONE } },
    });

    actors.onReconcile = () => Promise.resolve({
      kind: "settled",
      actorTurnId: "hturn_service_actor01",
      outcome: "succeeded",
      responseMarkdown: "Exact actor result after early reclamation.",
    });
    await value.service.observeSessionLifecycle({
      accountProfileId: ACCOUNT_ONE,
      threadId: "thread_service_observer",
      turnId: "turn_service_actor01",
      status: "completed",
    });
    await value.service.settled();
    expect(value.store.require(actorPane.id)).toMatchObject({
      activeTurnPoisoned: false,
      projection: {
        state: "ready",
        turn: {
          status: "completed",
          responseMarkdown: { tail: "Exact actor result after early reclamation." },
        },
      },
    });
  } finally {
    releaseActorAcceptance.resolve();
    for (const gate of gates.values()) gate.release.resolve();
    value.service.closeAdmission();
    value.database.close();
  }
});

test("attached actor projection overflow fences only the renderer and reconciles exact final Markdown", async () => {
  const actors = new FakeHarnessActors();
  const projectionEntered = deferred<void>();
  const releaseProjection = deferred<void>();
  let actorPaneId: string | null = null;
  let blockActorProjection = false;
  const value = harness(
    undefined,
    undefined,
    null,
    actors,
    null,
    undefined,
    null,
    undefined,
    undefined,
    () => 0,
    (delta) => {
      if (blockActorProjection && delta.paneId === actorPaneId) {
        projectionEntered.resolve();
        return releaseProjection.promise;
      }
      return undefined;
    },
  );
  try {
    const pane = attachObserver(value, "hactor_projection_overflow");
    actorPaneId = pane.id;
    await value.service.execute({
      type: "chat.turn.start",
      paneId: pane.id,
      expectedRevision: pane.revision,
      turnId: TURN_ONE,
      prompt: "Keep actor authority while the renderer is blocked.",
    });
    await value.service.settled();
    blockActorProjection = true;

    void value.service.observeSessionActivity({
      accountProfileId: ACCOUNT_ONE,
      threadId: "thread_service_observer",
      turnId: "turn_service_actor01",
      kind: "assistant_message_delta",
      assistantItemId: ASSISTANT_ITEM,
      displayText: "non-authoritative prefix",
    }).catch(() => undefined);
    void value.service.observeSessionToolItemStarted({
      accountProfileId: ACCOUNT_ONE,
      itemId: "item_actor_overflow_barrier",
      threadId: "thread_service_observer",
      turnId: "turn_service_actor01",
    }).catch(() => undefined);
    await projectionEntered.promise;
    for (let index = 0; index < 127; index += 1) {
      void value.service.observeSessionToolItemStarted({
        accountProfileId: ACCOUNT_ONE,
        itemId: `item_actor_overflow_${String(index).padStart(3, "0")}`,
        threadId: "thread_service_observer",
        turnId: "turn_service_actor01",
      }).catch(() => undefined);
    }

    expect(value.provider.interrupts).toEqual([]);
    expect(value.containedAccounts).toEqual([]);
    expect(value.store.require(pane.id)).toMatchObject({
      activeTurnPoisoned: false,
      providerTurnId: "turn_service_actor01",
      projection: { state: "streaming", turn: { id: TURN_ONE } },
    });

    releaseProjection.reject(new Error("renderer transport failed after saturation"));
    await value.service.settled();
    expect(value.provider.interrupts).toEqual([]);
    expect(value.containedAccounts).toEqual([]);
    expect(value.store.require(pane.id)).toMatchObject({
      activeTurnPoisoned: false,
      projection: { state: "streaming" },
    });

    actors.onReconcile = () => Promise.resolve({
      kind: "settled",
      actorTurnId: "hturn_service_actor01",
      outcome: "succeeded",
      responseMarkdown: "Authoritative result after renderer recovery.",
    });
    await value.service.observeSessionLifecycle({
      accountProfileId: ACCOUNT_ONE,
      threadId: "thread_service_observer",
      turnId: "turn_service_actor01",
      status: "completed",
    });
    await value.service.settled();

    expect(value.provider.interrupts).toEqual([]);
    expect(value.containedAccounts).toEqual([]);
    expect(value.store.require(pane.id)).toMatchObject({
      activeTurnPoisoned: false,
      projection: {
        state: "ready",
        turn: {
          status: "completed",
          responseMarkdown: { tail: "Authoritative result after renderer recovery." },
        },
      },
    });
  } finally {
    releaseProjection.resolve();
    value.service.closeAdmission();
    value.database.close();
  }
});

test("a durable delta failure interrupts once and ignores every later exact event", async () => {
  const value = harness();
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");
    value.store.appendDeltaBatches = () => {
      throw new Error("fixture durable write failure");
    };
    await value.service.observeSessionActivity(activity(
      started.request,
      started.turnId,
      "assistant_message_delta",
      "first",
    ));
    const failedRevision = value.store.require(PANE).projection.revision;
    await value.service.observeSessionActivity(activity(
      started.request,
      started.turnId,
      "assistant_message_delta",
      "later",
    ));
    await value.service.observeSessionLifecycle({
      ...lifecycle(started.request, started.turnId, "failed"),
      quotaProof: "provider_usage_limit_exceeded",
    });
    await value.service.settled();

    expect(value.provider.interrupts).toHaveLength(1);
    expect(value.provider.startedTurns).toHaveLength(1);
    expect(value.store.require(PANE)).toMatchObject({
      activeTurnPoisoned: true,
      projection: { state: "attention" },
    });
    expect(value.store.require(PANE).projection.revision).toBeGreaterThan(failedRevision);
  } finally {
    value.database.close();
  }
});

test("a failed poison write leaves the exact turn blocked for restart recovery", async () => {
  const value = harness();
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");
    value.store.appendDeltaBatches = () => {
      throw new Error("fixture durable write failure");
    };
    value.store.poisonTurn = () => {
      throw new Error("fixture recovery write failure");
    };
    const before = value.store.require(PANE).projection.revision;
    await value.service.observeSessionActivity(activity(
      started.request,
      started.turnId,
      "assistant_message_delta",
      "lost",
    ));
    await value.service.observeSessionLifecycle(lifecycle(
      started.request,
      started.turnId,
      "completed",
    ));
    await value.service.settled();

    expect(value.provider.interrupts).toHaveLength(1);
    expect(value.store.require(PANE).projection).toMatchObject({
      revision: before,
      state: "streaming",
      turn: { id: TURN_ONE, status: "streaming" },
    });
    expect(value.runtimeRecoveries).toEqual([{
      reason: "ambiguous_provider_effect_unfenced",
      accountProfileId: ACCOUNT_ONE,
      paneId: PANE,
      turnId: TURN_ONE,
    }]);
    const blocked = await startTurn(
      value,
      before,
      TURN_TWO,
      "blocked pending restart recovery",
    ).then(() => null, (error: unknown) => error);
    expect(blocked).toMatchObject({ code: "invalid_state" });
    expect(value.runtimeRecoveries).toHaveLength(1);
  } finally {
    value.database.close();
  }
});

test("a rejected retry cannot clear an in-memory poisoned-turn fence", async () => {
  const value = harness(() => [
    { id: ACCOUNT_ONE, selected: true, budget: "healthy" },
    { id: ACCOUNT_TWO, selected: false, budget: "healthy" },
  ]);
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");
    value.store.appendDeltaBatches = () => {
      throw new Error("fixture durable write failure");
    };
    value.store.poisonTurn = () => {
      throw new Error("fixture recovery write failure");
    };
    await value.service.observeSessionActivity(activity(
      started.request,
      started.turnId,
      "assistant_message_delta",
      "lost",
    ));
    const poisoned = value.store.require(PANE).projection;

    const retryError = await startTurn(
      value,
      poisoned.revision,
      TURN_TWO,
      "unsafe retry",
    ).then(() => null, (error: unknown) => error);
    if (!(retryError instanceof Error)) throw new Error("Expected the retry to fail.");
    expect(retryError.message).toContain("still being contained");
    await value.service.observeSessionLifecycle({
      ...lifecycle(started.request, started.turnId, "failed"),
      quotaProof: "provider_usage_limit_exceeded",
    });
    await value.service.settled();

    expect(value.provider.interrupts).toHaveLength(1);
    expect(value.provider.startedTurns).toHaveLength(1);
    expect(value.store.require(PANE).projection).toMatchObject({
      revision: poisoned.revision,
      state: "streaming",
    });
  } finally {
    value.database.close();
  }
});

test("account loss settles an accepted harness root with exact provider lineage", async () => {
  const roots = new FakeHarnessRoots();
  const value = harness(undefined, undefined, roots);
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");

    await value.service.handleAccountUnavailable(ACCOUNT_ONE);
    await value.service.settled();

    expect(roots.settlements).toEqual([]);
    expect(roots.observations).toEqual([{
      accountProfileId: ACCOUNT_ONE,
      threadId: started.request.threadId,
      turnId: started.turnId,
      status: "failed",
    }]);
    expect(value.store.require(PANE)).toMatchObject({
      binding: null,
      providerTurnId: null,
      projection: {
        state: "attention",
        attention: { code: "account_unavailable" },
      },
    });
  } finally {
    value.database.close();
  }
});

test("account shutdown does not interrupt an already-contained poisoned turn twice", async () => {
  const value = harness();
  try {
    const created = await createPane(value);
    await startTurn(value, created.revision);
    await value.service.settled();
    const started = value.provider.startedTurns[0];
    if (started === undefined) throw new Error("Expected provider turn");
    value.store.appendDeltaBatches = () => {
      throw new Error("fixture durable write failure");
    };
    value.store.poisonTurn = () => {
      throw new Error("fixture recovery write failure");
    };
    await value.service.observeSessionActivity(activity(
      started.request,
      started.turnId,
      "assistant_message_delta",
      "lost",
    ));
    expect(value.provider.interrupts).toHaveLength(1);

    await value.service.handleAccountUnavailable(ACCOUNT_ONE);
    await value.service.settled();

    expect(value.provider.interrupts).toHaveLength(1);
    expect(value.store.require(PANE)).toMatchObject({
      binding: null,
      providerTurnId: null,
      projection: {
        state: "attention",
        attention: { code: "account_unavailable" },
      },
    });
  } finally {
    value.database.close();
  }
});

function activity(
  request: ChatProviderTurnRequest,
  turnId: string,
  kind: SessionTurnActivity["kind"],
  displayText?: string,
): SessionTurnActivity {
  const base = {
    accountProfileId: request.accountProfileId,
    threadId: request.threadId,
    turnId,
  };
  if (kind === "assistant_message_delta") {
    return {
      ...base,
      kind,
      assistantItemId: ASSISTANT_ITEM,
      displayText: displayText ?? "delta",
    };
  }
  return kind === "reasoning_summary_delta"
    ? { ...base, kind, displayText: displayText ?? "delta" }
    : { ...base, kind };
}

function completion(
  request: ChatProviderTurnRequest,
  turnId: string,
  displayText: string,
): SessionAssistantItemCompletion {
  return {
    accountProfileId: request.accountProfileId,
    assistantItemId: ASSISTANT_ITEM,
    displayText,
    threadId: request.threadId,
    truncated: false,
    turnId,
  };
}

function lifecycle(
  request: ChatProviderTurnRequest,
  turnId: string,
  status: SessionTurnLifecycle["status"],
): SessionTurnLifecycle {
  return {
    accountProfileId: request.accountProfileId,
    threadId: request.threadId,
    turnId,
    status,
  };
}

function interactionRequest(
  started: StartedTurn,
  id: string,
): SessionInteractionRequest {
  return {
    accountProfileId: started.request.accountProfileId,
    threadId: started.request.threadId,
    turnId: started.turnId,
    request: {
      id,
      kind: "file_change_approval",
      scope: "once",
      createdAt: 1_000,
      expiresAt: 61_000,
    },
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

async function withinDeadline<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 2_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${label}.`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function createPristineDatabase(): Uint8Array {
  const database = new Database(":memory:", { strict: true });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    for (const [index, accountProfileId] of [
      ACCOUNT_ONE,
      ACCOUNT_TWO,
      ACCOUNT_THREE,
    ].entries()) {
      database.query(`
        INSERT INTO account_profiles (
          profile_id, label, auth_state, process_generation,
          selected, created_at, updated_at
        ) VALUES (?1, ?2, 'signed_in', 1, ?3, ?4, ?4)
      `).run(
        accountProfileId,
        `Chat ${String(index + 1)}`,
        index === 0 ? 1 : 0,
        "2026-08-03T12:00:00.000Z",
      );
    }
    return database.serialize();
  } finally {
    database.close();
  }
}

const pristineDatabase = createPristineDatabase();
