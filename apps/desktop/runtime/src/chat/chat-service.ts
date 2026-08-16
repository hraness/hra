import { accountProfileIdSchema, chatPaneIdSchema } from "../../../contracts/runtime";
import { ChatPaneStoreError } from "../state/chat-pane-store";
import type {
  ChatPaneDeltaBatchInput,
  ChatPaneDeltaBatchResult,
  ChatPaneStore,
} from "../state/chat-pane-store";
import type {
  SessionAssistantItemCompletion,
  SessionInteractionRequest,
  SessionReasoningItemCompletion,
  SessionToolItemStarted,
  SessionTurnActivity,
  SessionTurnLifecycle,
} from "../sessions/session-service";
import { utf8ByteLength, utf8Chunks } from "./text-bounds";
import {
  CHAT_MAX_DELTA_UTF8_BYTES,
  CHAT_MAX_ASSISTANT_RECONCILIATION_UTF8_BYTES,
  CHAT_MAX_RESPONSE_TAIL_UTF8_BYTES,
  CHAT_MODEL,
  ChatProviderEffectError,
  type ChatAccountCandidate,
  type ChatAccountProfileId,
  type ChatActivityDelta,
  type ChatCommandResult,
  type ChatHarnessActorTurnPort,
  type ChatHarnessRootPort,
  type ChatPaneCommand,
  type ChatPaneId,
  type ChatPanePrivateRecord,
  type ChatProjectionSink,
  type ChatQuotaProofCursor,
  type ChatProviderConfiguration,
  type ChatProviderPort,
  type ChatRepository,
  type ChatRepositoryPort,
  type ChatRuntimeRecoveryPort,
  type ChatAccountPort,
  type ChatThreadBinding,
  type ChatToolActivity,
  type ChatTurnId,
  type ChatTurnTerminal,
  type ChatUnexpectedInteraction,
  type ChatPaneProjection,
  type ChatWorkspacePort,
} from "./types";

const providerConfiguration = Object.freeze({
  model: CHAT_MODEL,
  approvalPolicy: "on-request",
  approvalsReviewer: "auto_review",
  sandbox: "workspace-write",
} as const);

const MAX_EARLY_SESSION_EVENT_KEYS_PER_PANE = 8;
const MAX_EARLY_SESSION_EVENTS_PER_PANE = 128;
const MAX_EARLY_SESSION_EVENT_UTF8_BYTES_PER_PANE = 640 * 1024;
const MAX_SESSION_PROJECTION_EVENTS_PER_PANE = 128;
const MAX_SESSION_PROJECTION_UTF8_BYTES_PER_PANE = 640 * 1024;
const MAX_SESSION_PROJECTION_EVENTS_GLOBAL = 512;
const MAX_SESSION_PROJECTION_UTF8_BYTES_GLOBAL = 8 * 1024 * 1024;
const MAX_COALESCED_DELTA_UTF8_BYTES = CHAT_MAX_RESPONSE_TAIL_UTF8_BYTES;
const DELTA_COALESCE_LATENCY_MILLISECONDS = 12;
const STREAM_PERSISTENCE_LATENCY_MILLISECONDS = 12;
const MAX_STREAM_PERSISTENCE_REQUESTS = 64;
const MAX_STREAM_PERSISTENCE_UTF8_BYTES = 8 * 1024 * 1024;
const MAX_EXACT_SESSION_ITEMS_PER_TURN = 512;
const MAX_WORKSPACE_RESOLUTION_RETRY_MILLISECONDS = 30_000;
const MAX_ATTACHED_HARNESS_RETRY_MILLISECONDS = 30_000;
const MAX_ATTACHED_HARNESS_RETRY_STAGE = 8;
const DEFAULT_INTERRUPT_TERMINAL_GRACE_MILLISECONDS = 500;
const DEFAULT_INTERRUPT_ACK_TIMEOUT_MILLISECONDS = 2_000;
const DEFAULT_HARNESS_ROOT_TRANSITION_TIMEOUT_MILLISECONDS = 5_000;
const DEFAULT_ACCOUNT_CONTAINMENT_TIMEOUT_MILLISECONDS = 5_000;
const DEFAULT_HARNESS_ACTOR_TRANSITION_TIMEOUT_MILLISECONDS = 5_000;

type SessionEffect =
  | Readonly<{
      readonly type: "delta_batch";
      readonly channel: "reasoningSummary" | "responseMarkdown";
      readonly deltas: readonly string[];
      readonly assistantMessageId?: string;
    }>
  | Readonly<{
      readonly type: "assistant_completed";
      readonly assistantMessageId: string;
      readonly fullText: string;
      readonly truncated: boolean;
    }>
  | Readonly<{ readonly type: "tool_started" | "tool_completed" }>
  | Readonly<{
      readonly type: "tool_item_started" | "reasoning_item_completed";
      readonly itemId: string;
    }>
  | Readonly<{ readonly type: "unexpected_interaction" }>
  | Readonly<{ readonly type: "protocol_failure" }>
  | Readonly<{
      readonly type: "terminal";
      readonly outcome: "completed" | "failed" | "interrupted";
      readonly quotaProof?: "provider_rate_limit_reached";
    }>;

interface SessionEventEnvelope {
  readonly accountProfileId: ChatAccountProfileId;
  readonly providerThreadId: string;
  readonly providerTurnId: string;
  readonly effect: SessionEffect;
}

interface EarlySessionEventBuffer {
  readonly events: SessionEventEnvelope[];
  bytes: number;
  overflowed: boolean;
}

interface PaneEarlySessionEvents {
  readonly byKey: Map<string, EarlySessionEventBuffer>;
  readonly overflowedKeys: Set<string>;
  readonly terminalKeys: Set<string>;
  eventCount: number;
  totalBytes: number;
  unknownOverflow: boolean;
}

interface TurnContainmentTarget {
  readonly paneId: ChatPaneId;
  readonly turnId: ChatTurnId;
  readonly binding: ChatThreadBinding | null;
  readonly providerTurnId: string | null;
}

interface SessionProjectionQueueEntry {
  readonly event: SessionEventEnvelope;
  readonly target: TurnContainmentTarget;
  readonly bytes: number;
}

interface SessionProjectionQueue {
  readonly entries: SessionProjectionQueueEntry[];
  readonly settlement: Promise<void>;
  readonly resolveSettlement: () => void;
  bytes: number;
  draining: boolean;
  inFlight: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

interface PendingStreamPersistence {
  readonly input: ChatPaneDeltaBatchInput;
  readonly bytes: number;
  readonly resolve: (result: ChatPaneDeltaBatchResult | null) => void;
  readonly reject: (error: unknown) => void;
}

interface PendingTurnStop {
  readonly turnId: ChatTurnId;
  readonly promise: Promise<ChatPaneProjection>;
  readonly resolve: (pane: ChatPaneProjection) => void;
  readonly reject: (error: unknown) => void;
}

interface ExactProviderTerminalWaiter {
  readonly paneId: ChatPaneId;
  readonly logicalTurnId: ChatTurnId;
  readonly accountProfileId: ChatAccountProfileId;
  readonly providerThreadId: string;
  readonly providerTurnId: string;
  readonly promise: Promise<SessionTurnLifecycle>;
  readonly resolve: (lifecycle: SessionTurnLifecycle) => void;
  interrupt: Promise<void> | null;
}

interface ExactProviderTerminalReceipt {
  readonly logicalTurnId: ChatTurnId;
  readonly lifecycle: SessionTurnLifecycle;
  owner: "unclaimed" | "projection" | "containment";
}

interface PendingTurnContainment {
  readonly turnId: ChatTurnId;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

interface AttachedHarnessProjectionFence {
  readonly turnId: ChatTurnId;
  readonly providerTurnId: string | null;
}

interface ReclaimableSessionBacklog {
  readonly paneId: ChatPaneId;
  readonly kind: "early" | "projection";
  readonly entries: number;
  readonly bytes: number;
  readonly target: TurnContainmentTarget | null;
  readonly providerMayStillRun: boolean;
}

interface AttachedHarnessStartupRetry {
  readonly paneId: ChatPaneId;
  readonly turnId: ChatTurnId;
  inFlight: boolean;
  retryStage: number;
  timer: ReturnType<typeof setTimeout> | null;
}

type AttachedHarnessAttemptResult = "recovering" | "resolved" | "stale";

class ChatContainmentFailure extends Error {
  constructor() {
    super("The ambiguous provider effect could not be fenced.");
    this.name = "ChatContainmentFailure";
  }
}

class ChatHarnessActorTransitionTimeout extends Error {
  constructor() {
    super("The persistent actor transition exceeded its bounded deadline.");
    this.name = "ChatHarnessActorTransitionTimeout";
  }
}

export interface ChatServiceOptions {
  readonly accounts: ChatAccountPort;
  readonly harnessActors?: ChatHarnessActorTurnPort;
  readonly harnessRoots?: ChatHarnessRootPort;
  readonly now?: () => Date;
  readonly projection: ChatProjectionSink;
  readonly provider: ChatProviderPort;
  readonly repositories: ChatRepositoryPort;
  readonly runtimeRecovery: ChatRuntimeRecoveryPort;
  readonly store: ChatPaneStore;
  readonly workspaces: ChatWorkspacePort;
  readonly attachedHarnessRetryDelayMs?: (attempt: number) => number;
  readonly workspaceRetryDelayMs?: (attempt: number) => number;
  readonly interruptTerminalGraceMs?: number;
  readonly interruptAckTimeoutMs?: number;
  readonly harnessRootTransitionTimeoutMs?: number;
  readonly accountContainmentTimeoutMs?: number;
  readonly harnessActorTransitionTimeoutMs?: number;
}

export class ChatService {
  readonly #accounts: ChatAccountPort;
  readonly #harnessActors: ChatHarnessActorTurnPort | null;
  readonly #harnessRoots: ChatHarnessRootPort | null;
  readonly #now: () => Date;
  readonly #projection: ChatProjectionSink;
  readonly #provider: ChatProviderPort;
  readonly #repositories: ChatRepositoryPort;
  readonly #runtimeRecovery: ChatRuntimeRecoveryPort;
  readonly #store: ChatPaneStore;
  readonly #workspaces: ChatWorkspacePort;
  readonly #attachedHarnessRetryDelayMs: (attempt: number) => number;
  readonly #workspaceRetryDelayMs: (attempt: number) => number;
  readonly #interruptTerminalGraceMs: number;
  readonly #interruptAckTimeoutMs: number;
  readonly #harnessRootTransitionTimeoutMs: number;
  readonly #accountContainmentTimeoutMs: number;
  readonly #harnessActorTransitionTimeoutMs: number;
  readonly #paneTails = new Map<ChatPaneId, Promise<void>>();
  readonly #providerEffects = new Set<Promise<void>>();
  readonly #sessionProjectionQueues = new Map<ChatPaneId, SessionProjectionQueue>();
  readonly #pendingStreamPersistence: PendingStreamPersistence[] = [];
  readonly #pendingTurnStops = new Map<ChatPaneId, PendingTurnStop>();
  readonly #pendingTurnContainments = new Map<ChatPaneId, PendingTurnContainment>();
  readonly #exactProviderTerminalReceipts =
    new Map<ChatPaneId, ExactProviderTerminalReceipt>();
  readonly #exactProviderTerminalWaiters = new Map<ChatPaneId, ExactProviderTerminalWaiter>();
  readonly #earlySessionEvents = new Map<ChatPaneId, PaneEarlySessionEvents>();
  readonly #attachedHarnessProjectionFences = new Map<
    ChatPaneId,
    AttachedHarnessProjectionFence
  >();
  readonly #attachedHarnessRecoveryRequestedTurns = new Map<ChatPaneId, ChatTurnId>();
  readonly #harnessRootTurns = new Map<ChatPaneId, Readonly<{
    chatTurnId: ChatTurnId;
    rootTurnId: string;
  }>>();
  readonly #poisonedTurns = new Map<ChatPaneId, ChatTurnId>();
  readonly #recoveryFencedTurns = new Map<ChatPaneId, ChatTurnId>();
  readonly #observedSessionItemEvents = new Map<ChatPaneId, Set<string>>();
  readonly #quotaProofFloors = new Map<ChatPaneId, Readonly<{
    readonly turnId: ChatTurnId;
    readonly accountProfileId: ChatAccountProfileId;
    readonly cursor: ChatQuotaProofCursor;
  }>>();
  readonly #priorQuotaTerminals = new Map<ChatPaneId, Readonly<{
    readonly turnId: ChatTurnId;
    readonly lifecycle: SessionTurnLifecycle;
  }>>();
  readonly #workspaceResolutionRetryAttempts = new Map<ChatPaneId, number>();
  readonly #workspaceResolutionRetryTimers = new Map<
    ChatPaneId,
    ReturnType<typeof setTimeout>
  >();
  readonly #attachedHarnessStartupRetries = new Map<
    ChatPaneId,
    AttachedHarnessStartupRetry
  >();
  #earlySessionEventCount = 0;
  #earlySessionEventUtf8Bytes = 0;
  #sessionProjectionEventCount = 0;
  #sessionProjectionUtf8Bytes = 0;
  #sessionProjectionInFlightUtf8Bytes = 0;
  #pendingStreamPersistenceUtf8Bytes = 0;
  #streamPersistenceTimer: ReturnType<typeof setTimeout> | null = null;
  #admissionClosed = false;

  constructor(options: ChatServiceOptions) {
    this.#accounts = options.accounts;
    this.#harnessActors = options.harnessActors ?? null;
    this.#harnessRoots = options.harnessRoots ?? null;
    this.#now = options.now ?? (() => new Date());
    this.#projection = options.projection;
    this.#provider = options.provider;
    this.#repositories = options.repositories;
    this.#runtimeRecovery = options.runtimeRecovery;
    this.#store = options.store;
    this.#workspaces = options.workspaces;
    this.#attachedHarnessRetryDelayMs = options.attachedHarnessRetryDelayMs ??
      attachedHarnessRetryDelay;
    this.#workspaceRetryDelayMs = options.workspaceRetryDelayMs ??
      workspaceResolutionRetryDelay;
    this.#interruptTerminalGraceMs = validateInterruptTerminalGrace(
      options.interruptTerminalGraceMs ?? DEFAULT_INTERRUPT_TERMINAL_GRACE_MILLISECONDS,
    );
    this.#interruptAckTimeoutMs = validateInterruptAckTimeout(
      options.interruptAckTimeoutMs ?? DEFAULT_INTERRUPT_ACK_TIMEOUT_MILLISECONDS,
    );
    this.#harnessRootTransitionTimeoutMs = validateHarnessRootTransitionTimeout(
      options.harnessRootTransitionTimeoutMs ??
        DEFAULT_HARNESS_ROOT_TRANSITION_TIMEOUT_MILLISECONDS,
    );
    this.#accountContainmentTimeoutMs = validateAccountContainmentTimeout(
      options.accountContainmentTimeoutMs ??
        DEFAULT_ACCOUNT_CONTAINMENT_TIMEOUT_MILLISECONDS,
    );
    this.#harnessActorTransitionTimeoutMs = validateHarnessActorTransitionTimeout(
      options.harnessActorTransitionTimeoutMs ??
        DEFAULT_HARNESS_ACTOR_TRANSITION_TIMEOUT_MILLISECONDS,
    );
  }

  initialize(): readonly ChatPaneProjection[] {
    this.#store.recoverInterrupted(this.#now(), {
      preserveAttachedHarness: this.#harnessActors !== null,
    });
    const panes = this.#store.list();
    for (const pane of panes) {
      if (
        pane.interactionMode === "chat" && pane.workspace !== null &&
        pane.workspace.mode === "managedWorktree" &&
        pane.workspace.state !== "preserved"
      ) this.#scheduleWorkspaceProvision(pane.id);
    }
    if (this.#harnessActors !== null) {
      for (const pane of panes) {
        if (
          pane.interactionMode !== "harnessObserver" ||
          !activePane(pane) || pane.turn === null
        ) continue;
        const privatePane = this.#store.get(pane.id);
        this.#beginAttachedHarnessStartupRecovery(
          pane.id,
          pane.turn.id,
          privatePane !== null && privatePane.providerTurnId !== null,
        );
      }
    }
    return panes;
  }

  list(): readonly ChatPaneProjection[] {
    return this.#store.list();
  }

  async handleAccountUnavailable(accountProfileId: ChatAccountProfileId): Promise<void> {
    const accountId = accountProfileIdSchema.parse(accountProfileId);
    const paneIds = this.#store.paneIdsReferencingAccount(accountId);
    await Promise.all(paneIds.map((paneId) => {
      this.#clearAttachedHarnessStartupRetry(paneId);
      this.#attachedHarnessProjectionFences.delete(paneId);
      this.#discardSessionProjectionQueue(paneId);
      return this.#serialize(paneId, async () => {
      const pane = this.#store.get(paneId);
      if (pane === null) return;
      if (pane.projection.turn !== null && activePane(pane.projection)) {
        if (pane.providerTurnId === null) {
          await this.#settleHarnessBeforeProvider(
            paneId,
            pane.projection.turn.id,
            "provider_start_ambiguous",
          );
        } else {
          if (
            pane.binding === null ||
            pane.binding.accountProfileId !== accountId
          ) {
            throw new ChatPaneStoreError(
              "corrupt_state",
              "An active provider turn lost its exact account binding.",
            );
          }
          // Account loss is terminal proof for a turn that the provider had
          // already accepted. Preserve its exact provider lineage until the
          // root authority consumes that proof; the pre-provider ambiguity
          // escape hatch is invalid after a provider turn exists.
          await this.#observeHarnessTerminal(
            paneId,
            pane.projection.turn.id,
            {
              accountProfileId: accountId,
              threadId: pane.binding.threadId,
              turnId: pane.providerTurnId,
              status: "failed",
            },
          );
        }
      }
      // Callers invoke this only after the account generation has stopped,
      // failed, or been removed. A provider request here could lazily relaunch
      // the unavailable account, so detachment is deliberately state-only.
      this.#discardEarlySessionEvents(paneId);
      this.#observedSessionItemEvents.delete(paneId);
      this.#quotaProofFloors.delete(paneId);
      const detached = this.#store.detachUnavailableAccount(paneId, accountId, this.#now());
      if (detached !== null) await this.#projection.paneStateChanged(detached);
      });
    }));
  }

  findByProviderThread(
    accountProfileId: ChatAccountProfileId,
    providerThreadId: string,
  ): ChatPanePrivateRecord | null {
    return this.#store.findByProviderThread(accountProfileId, providerThreadId);
  }

  /** Waits until every operation currently admitted to a pane tail has settled. */
  async settled(): Promise<void> {
    for (;;) {
      for (const [paneId, queue] of this.#sessionProjectionQueues) {
        if (queue.entries.length > 0 && !queue.draining) {
          this.#startSessionProjectionDrain(paneId, queue);
        }
      }
      this.#flushStreamPersistence();
      const tails = [...this.#paneTails.values()];
      const effects = [...this.#providerEffects];
      if (
        tails.length === 0 &&
        effects.length === 0 &&
        this.#sessionProjectionEventCount === 0 &&
        this.#pendingStreamPersistence.length === 0
      ) return;
      await Promise.all([
        ...tails.map((tail) => tail.catch(() => undefined)),
        ...effects.map((effect) => effect.catch(() => undefined)),
      ]);
    }
  }

  /**
   * Synchronously closes host-command admission while retaining provider fact
   * routing. A command that returned past this fence already registered its
   * pane tail and is therefore included by `settled()`.
   */
  closeAdmission(): void {
    this.#admissionClosed = true;
    this.#flushStreamPersistence();
    for (const retry of this.#attachedHarnessStartupRetries.values()) {
      if (retry.timer !== null) clearTimeout(retry.timer);
    }
    this.#attachedHarnessStartupRetries.clear();
    for (const timer of this.#workspaceResolutionRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.#workspaceResolutionRetryTimers.clear();
    this.#workspaceResolutionRetryAttempts.clear();
  }

  /**
   * Exact SessionService activity join. Early events are held until the
   * provider turn returned by startChatTurn is durably bound to the pane.
   */
  observeSessionActivity(event: SessionTurnActivity): Promise<void> {
    const base = {
      accountProfileId: event.accountProfileId,
      providerThreadId: event.threadId,
      providerTurnId: event.turnId,
    };
    switch (event.kind) {
      case "reasoning_summary_delta":
        return this.#observeSessionDelta(base, "reasoningSummary", event.displayText);
      case "assistant_message_delta":
        return this.#observeSessionDelta(
          base,
          "responseMarkdown",
          event.displayText,
          event.assistantItemId,
        );
      case "tool_activity_started":
        return this.#observeSessionEvent({ ...base, effect: { type: "tool_started" } });
      case "tool_activity_completed":
        return this.#observeSessionEvent({ ...base, effect: { type: "tool_completed" } });
      case "waiting_for_approval":
      case "waiting_for_input":
        // SessionService invokes the exact interaction callback immediately
        // after this activity. That callback owns fail-closed rejection so a
        // completed attention transition cannot make the request look unowned.
        return Promise.resolve();
      case "editing":
      case "planning":
      case "running":
      case "testing":
        return Promise.resolve();
    }
  }

  /** Reconciles one provider-completed assistant item against its durable stream. */
  observeSessionAssistantCompletion(event: SessionAssistantItemCompletion): Promise<void> {
    const fullTextBytes = utf8ByteLength(event.displayText);
    const safelyRetained = !event.truncated &&
      fullTextBytes <= CHAT_MAX_ASSISTANT_RECONCILIATION_UTF8_BYTES;
    return this.#observeSessionEvent({
      accountProfileId: event.accountProfileId,
      providerThreadId: event.threadId,
      providerTurnId: event.turnId,
      effect: {
        type: "assistant_completed",
        assistantMessageId: event.assistantItemId,
        fullText: safelyRetained ? event.displayText : "",
        truncated: !safelyRetained,
      },
    });
  }

  observeSessionToolItemStarted(event: SessionToolItemStarted): Promise<void> {
    return this.#observeSessionEvent({
      accountProfileId: event.accountProfileId,
      providerThreadId: event.threadId,
      providerTurnId: event.turnId,
      effect: { type: "tool_item_started", itemId: event.itemId },
    });
  }

  observeSessionReasoningCompletion(event: SessionReasoningItemCompletion): Promise<void> {
    return this.#observeSessionEvent({
      accountProfileId: event.accountProfileId,
      providerThreadId: event.threadId,
      providerTurnId: event.turnId,
      effect: { type: "reasoning_item_completed", itemId: event.itemId },
    });
  }

  /** Exact SessionService lifecycle join for the active owned provider turn. */
  observeSessionLifecycle(event: SessionTurnLifecycle): Promise<void> {
    if (event.status === "inProgress") return Promise.resolve();
    // Provider terminal authority must not wait behind renderer projection.
    // Stop registers this exact five-part lineage before interrupting; once a
    // matching lifecycle reaches the runtime boundary, the provider attempt is
    // no longer ambiguous even if an older delta is still draining to the UI.
    if (this.#recordExactProviderTerminalAtIngress(event)) {
      return Promise.resolve();
    }
    return this.#observeSessionEvent({
      accountProfileId: event.accountProfileId,
      providerThreadId: event.threadId,
      providerTurnId: event.turnId,
      effect: {
        type: "terminal",
        outcome: event.status,
        ...(event.quotaProof === "provider_usage_limit_exceeded"
          ? { quotaProof: "provider_rate_limit_reached" as const }
          : {}),
      },
    });
  }

  /**
   * Returns true only when this request belongs to an active chat pane. The
   * caller must then return null so SessionService rejects it at the provider
   * boundary instead of registering a renderer-facing interaction.
   */
  async observeSessionInteractionRequest(event: SessionInteractionRequest): Promise<boolean> {
    const pane = this.#chatPaneForSessionEvent(
      event.accountProfileId,
      event.threadId,
      event.turnId,
    );
    if (
      pane === null ||
      !activePane(pane.projection) ||
      pane.projection.turn === null ||
      pane.providerTurnId !== event.turnId ||
      this.#poisonedTurns.get(pane.projection.id) === pane.projection.turn.id
    ) return false;
    // Reject HITL at the provider boundary immediately. Renderer projection is
    // deliberately not an admission dependency: a blocked delta must never
    // leave Codex waiting for an approval HRA cannot safely answer.
    if (
      this.#pendingTurnStops.get(pane.projection.id)?.turnId === pane.projection.turn.id ||
      this.#pendingTurnContainments.get(pane.projection.id)?.turnId ===
        pane.projection.turn.id
    ) return true;
    await this.#applyUnexpectedInteraction({
      paneId: pane.projection.id,
      turnId: pane.projection.turn.id,
    });
    return true;
  }

  execute(command: ChatPaneCommand): Promise<ChatCommandResult> {
    if (this.#admissionClosed) {
      return Promise.reject(new ChatPaneStoreError(
        "invalid_state",
        "Chat command admission is closed.",
      ));
    }
    if (command.type === "chat.turn.stop") {
      return this.#requestTurnStop(command).then((pane) => ({ type: "pane", pane }));
    }
    switch (command.type) {
      case "chat.pane.create":
        return this.#serialize(command.paneId, async () => {
          const repository = await this.#repositories.resolve(command.repositoryId);
          if (repository === null || repository.id !== command.repositoryId) {
            throw new ChatPaneStoreError("not_found", "This repository is unavailable.");
          }
          const pane = this.#store.create({
            paneId: command.paneId,
            repository,
            accountProfileId: null,
            reasoningEffort: command.reasoningEffort,
            serviceTier: command.serviceTier ?? "standard",
            now: this.#now(),
          });
          await this.#projection.paneChanged(pane);
          this.#scheduleWorkspaceProvision(pane.id, repository);
          return { type: "pane", pane };
        });
      case "chat.pane.rename":
        return this.#serialize(command.paneId, async () => {
          const pane = this.#store.rename(
            command.paneId,
            command.expectedRevision,
            command.title,
            this.#now(),
          );
          await this.#projection.paneStateChanged(pane);
          const binding = this.#store.require(command.paneId).binding;
          if (binding !== null) this.#bestEffortName(binding, pane.title);
          return { type: "pane", pane };
        });
      case "chat.pane.configure":
        return this.#serialize(command.paneId, async () => {
          const pane = this.#store.configure(
            command.paneId,
            command.expectedRevision,
            command.reasoningEffort,
            this.#now(),
            command.serviceTier,
          );
          await this.#projection.paneStateChanged(pane);
          if (pane.workspace?.state !== "ready") {
            this.#scheduleWorkspaceProvision(pane.id);
          }
          return { type: "pane", pane };
        });
      case "chat.pane.repository.select":
        return this.#serialize(command.paneId, async () => {
          const repository = await this.#repositories.resolve(command.repositoryId);
          if (repository === null || repository.id !== command.repositoryId) {
            throw new ChatPaneStoreError("not_found", "This repository is unavailable.");
          }
          const pane = this.#store.selectRepository(
            command.paneId,
            command.expectedRevision,
            repository,
            this.#now(),
          );
          await this.#projection.paneChanged(pane);
          if (pane.workspace?.state !== "ready") {
            this.#scheduleWorkspaceProvision(pane.id, repository);
          }
          return { type: "pane", pane };
        });
      case "chat.pane.remove":
        return this.#serialize(command.paneId, async () => {
          const removed = this.#store.remove(
            command.paneId,
            command.expectedRevision,
            this.#now(),
          );
          this.#workspaces.release(command.paneId);
          this.#discardSessionProjectionQueue(command.paneId);
          this.#discardEarlySessionEvents(command.paneId);
          this.#observedSessionItemEvents.delete(command.paneId);
          this.#harnessRootTurns.delete(command.paneId);
          this.#quotaProofFloors.delete(command.paneId);
          this.#priorQuotaTerminals.delete(command.paneId);
          this.#exactProviderTerminalReceipts.delete(command.paneId);
          this.#poisonedTurns.delete(command.paneId);
          this.#recoveryFencedTurns.delete(command.paneId);
          this.#attachedHarnessProjectionFences.delete(command.paneId);
          this.#attachedHarnessRecoveryRequestedTurns.delete(command.paneId);
          this.#clearAttachedHarnessStartupRetry(command.paneId);
          this.#clearWorkspaceResolutionRetry(command.paneId);
          await this.#projection.paneRemoved(removed.paneId, removed.revision);
          return { type: "removed", ...removed };
        });
      case "chat.panes.reorder":
        return Promise.resolve().then(async () => {
          const orderedPaneIds = this.#store.reorder(
            command.expectedOrderedPaneIds,
            command.orderedPaneIds,
          );
          await this.#projection.panesReordered(orderedPaneIds);
          return { type: "reordered" as const, orderedPaneIds };
        });
      case "chat.turn.start":
        return this.#serialize(command.paneId, async () => {
          if (this.#pendingTurnStops.has(command.paneId)) {
            throw new ChatPaneStoreError(
              "invalid_state",
              "The prior provider turn is still stopping. Wait before sending another message.",
            );
          }
          if (this.#pendingTurnContainments.has(command.paneId)) {
            throw new ChatPaneStoreError(
              "invalid_state",
              "The prior provider turn is still being contained. Wait before sending another message.",
            );
          }
          if (this.#recoveryFencedTurns.has(command.paneId)) {
            throw new ChatPaneStoreError(
              "invalid_state",
              "The chat runtime is recovering an uncertain provider turn. Wait for recovery before sending another message.",
            );
          }
          const current = this.#store.require(command.paneId);
          const attachedActor = current.projection.interactionMode === "harnessObserver";
          if (attachedActor && this.#harnessActors === null) {
            throw new ChatPaneStoreError(
              "invalid_state",
              "Persistent actor messaging is unavailable.",
            );
          }
          if (
            !attachedActor &&
            current.projection.workspace?.state !== "ready"
          ) {
            throw new ChatPaneStoreError(
              "invalid_state",
              "Create or recover this pane's isolated workspace before sending a message.",
            );
          }
          const admission = (attachedActor
            ? this.#store.beginAttachedHarnessTurn.bind(this.#store)
            : this.#store.beginTurn.bind(this.#store))({
            paneId: command.paneId,
            expectedRevision: command.expectedRevision,
            turnId: command.turnId,
            prompt: command.prompt,
            now: this.#now(),
          });
          if (admission.kind === "replayed") {
            throw new ChatPaneStoreError(
              "conflict",
              "This chat turn was already admitted.",
            );
          }
          const begun = admission.pane;
          this.#attachedHarnessProjectionFences.delete(command.paneId);
          this.#attachedHarnessRecoveryRequestedTurns.delete(command.paneId);
          this.#discardSessionProjectionQueue(command.paneId);
          this.#discardEarlySessionEvents(command.paneId);
          this.#observedSessionItemEvents.delete(command.paneId);
          this.#quotaProofFloors.delete(command.paneId);
          this.#priorQuotaTerminals.delete(command.paneId);
          this.#exactProviderTerminalReceipts.delete(command.paneId);
          this.#poisonedTurns.delete(command.paneId);
          await this.#projection.paneChanged(begun);
          void this.#serialize(command.paneId, async () => {
            try {
              if (attachedActor) {
                const outcome = await this.#startAttachedHarnessTurn(
                  command.paneId,
                  command.turnId,
                );
                if (outcome === "recovering") {
                  this.#beginAttachedHarnessStartupRecovery(
                    command.paneId,
                    command.turnId,
                    true,
                    true,
                  );
                }
              } else {
                await this.#startLogicalTurn(command.paneId, command.turnId);
              }
            } catch {
              if (attachedActor) {
                // Actor admission exceptions carry no terminal authority. The
                // exact durable turn remains active while reconciliation
                // determines whether the original effect was accepted.
                this.#beginAttachedHarnessStartupRecovery(
                  command.paneId,
                  command.turnId,
                  true,
                  true,
                );
                return;
              }
              if (this.#poisonedTurns.get(command.paneId) === command.turnId) {
                return;
              }
              try {
                await this.#settleHarnessBeforeProvider(
                  command.paneId,
                  command.turnId,
                  "provider_start_ambiguous",
                );
              } catch {
                // The root transition already fenced this exact turn and
                // requested Native recovery. Never publish a reusable state.
                return;
              }
              await this.#publishAttention(command.paneId, command.turnId, {
                code: "runtime_unavailable",
                message: "The chat runtime could not start this turn. You can send another message.",
                retryable: true,
              }, true);
            }
          }).catch(() => {
            this.#poisonActiveTurnAndRequestRecovery(command.paneId, command.turnId);
          });
          return { type: "pane", pane: begun };
        });
      case "chat.turn.retry":
        return this.#serialize(command.paneId, async () => {
          if (this.#pendingTurnStops.has(command.paneId)) {
            throw new ChatPaneStoreError(
              "invalid_state",
              "The prior provider turn is still stopping. Wait before retrying.",
            );
          }
          if (this.#pendingTurnContainments.has(command.paneId)) {
            throw new ChatPaneStoreError(
              "invalid_state",
              "The prior provider turn is still being contained. Wait before retrying.",
            );
          }
          if (this.#recoveryFencedTurns.has(command.paneId)) {
            throw new ChatPaneStoreError(
              "invalid_state",
              "The chat runtime is recovering an uncertain provider turn. Wait for recovery before retrying.",
            );
          }
          const current = this.#store.require(command.paneId);
          if (
            current.projection.interactionMode !== "chat" ||
            current.projection.workspace?.state !== "ready"
          ) {
            throw new ChatPaneStoreError(
              "invalid_state",
              "Create or recover this pane's isolated workspace before retrying.",
            );
          }
          const admission = this.#store.retryTurn({
            paneId: command.paneId,
            expectedRevision: command.expectedRevision,
            priorFailedTurnId: command.priorFailedTurnId,
            turnId: command.turnId,
            now: this.#now(),
          });
          if (admission.kind === "replayed") {
            throw new ChatPaneStoreError(
              "conflict",
              "This retry turn was already admitted.",
            );
          }
          const begun = admission.pane;
          this.#attachedHarnessProjectionFences.delete(command.paneId);
          this.#discardSessionProjectionQueue(command.paneId);
          this.#discardEarlySessionEvents(command.paneId);
          this.#observedSessionItemEvents.delete(command.paneId);
          this.#quotaProofFloors.delete(command.paneId);
          this.#priorQuotaTerminals.delete(command.paneId);
          this.#exactProviderTerminalReceipts.delete(command.paneId);
          this.#poisonedTurns.delete(command.paneId);
          await this.#projection.paneChanged(begun);
          void this.#serialize(command.paneId, async () => {
            try {
              await this.#startLogicalTurn(command.paneId, command.turnId);
            } catch {
              if (this.#poisonedTurns.get(command.paneId) === command.turnId) return;
              try {
                await this.#settleHarnessBeforeProvider(
                  command.paneId,
                  command.turnId,
                  "provider_start_ambiguous",
                );
              } catch {
                return;
              }
              await this.#publishAttention(command.paneId, command.turnId, {
                code: "runtime_unavailable",
                message: "The chat runtime could not retry this turn. You can retry again.",
                retryable: true,
              }, true);
            }
          }).catch(() => {
            this.#poisonActiveTurnAndRequestRecovery(command.paneId, command.turnId);
          });
          return { type: "pane", pane: begun };
        });
    }
  }

  handleDelta(activity: ChatActivityDelta): Promise<void> {
    return this.#serialize(activity.paneId, () =>
      this.#applyDirectWithContainment(activity.paneId, activity.turnId, async () => {
        await this.#applyDelta(activity);
      }));
  }

  handleToolStarted(activity: ChatToolActivity): Promise<void> {
    return this.#serialize(activity.paneId, () =>
      this.#applyDirectWithContainment(activity.paneId, activity.turnId, async () => {
        await this.#applyToolStarted(activity);
      }));
  }

  handleToolCompleted(activity: ChatToolActivity): Promise<void> {
    return this.#serialize(activity.paneId, () =>
      this.#applyDirectWithContainment(activity.paneId, activity.turnId, async () => {
        await this.#applyToolCompleted(activity);
      }));
  }

  handleTurnTerminal(event: ChatTurnTerminal): Promise<void> {
    return this.#serialize(event.paneId, () =>
      this.#applyDirectWithContainment(event.paneId, event.turnId, async () => {
        await this.#applyTurnTerminal(event);
      }, true));
  }

  handleUnexpectedInteraction(event: ChatUnexpectedInteraction): Promise<void> {
    return this.#serialize(event.paneId, () =>
      this.#applyDirectWithContainment(event.paneId, event.turnId, async () => {
        await this.#applyUnexpectedInteraction(event);
      }));
  }

  #observeSessionDelta(
    base: Omit<SessionEventEnvelope, "effect">,
    channel: "reasoningSummary" | "responseMarkdown",
    displayText: string,
    assistantMessageId?: string,
  ): Promise<void> {
    let chunks: readonly string[];
    try {
      chunks = utf8Chunks(displayText, CHAT_MAX_DELTA_UTF8_BYTES);
    } catch {
      return this.#observeSessionEvent({ ...base, effect: { type: "protocol_failure" } });
    }
    if (chunks.length === 0) return Promise.resolve();
    return this.#observeSessionEvent({
      ...base,
      effect: {
        type: "delta_batch",
        channel,
        deltas: chunks,
        ...(assistantMessageId === undefined ? {} : { assistantMessageId }),
      },
    });
  }

  #observeSessionEvent(event: SessionEventEnvelope): Promise<void> {
    const pane = this.#chatPaneForSessionEvent(
      event.accountProfileId,
      event.providerThreadId,
      event.providerTurnId,
    );
    if (
      pane === null ||
      !activePane(pane.projection) ||
      pane.projection.turn === null ||
      this.#poisonedTurns.get(pane.projection.id) === pane.projection.turn.id ||
      this.#pendingTurnStops.get(pane.projection.id)?.turnId === pane.projection.turn.id &&
        event.effect.type !== "terminal" ||
      this.#pendingTurnContainments.get(pane.projection.id)?.turnId === pane.projection.turn.id &&
        event.effect.type !== "terminal"
    ) return Promise.resolve();
    const fence = this.#attachedHarnessProjectionFences.get(pane.projection.id);
    if (
      fence?.turnId === pane.projection.turn.id &&
      (fence.providerTurnId === null || fence.providerTurnId === event.providerTurnId) &&
      event.effect.type !== "terminal"
    ) return Promise.resolve();
    if (pane.providerTurnId === null) {
      this.#bufferEarlySessionEvent(pane.projection.id, event);
      return Promise.resolve();
    }
    if (pane.providerTurnId !== event.providerTurnId) return Promise.resolve();
    const settlement = this.#admitSessionProjectionEvent(containmentTarget(pane), event);
    // Every admitted event shares this pane queue's one settlement promise.
    // SessionService deliberately dispatches observers fire-and-forget, so a
    // slow renderer cannot propagate pressure into provider RPC; direct joins
    // can still await deterministic drain completion without per-event tails.
    return settlement;
  }

  #admitSessionProjectionEvent(
    target: TurnContainmentTarget,
    event: SessionEventEnvelope,
  ): Promise<void> {
    if (
      this.#poisonedTurns.get(target.paneId) === target.turnId ||
      this.#pendingTurnStops.get(target.paneId)?.turnId === target.turnId &&
        event.effect.type !== "terminal" ||
      this.#pendingTurnContainments.get(target.paneId)?.turnId === target.turnId &&
        event.effect.type !== "terminal"
    ) return Promise.resolve();
    if (
      this.#isExactAttachedHarnessProjectionFenced(target) &&
      event.effect.type !== "terminal"
    ) return Promise.resolve();
    let queue = this.#sessionProjectionQueues.get(target.paneId);
    if (queue === undefined) {
      let resolveSettlement!: () => void;
      const settlement = new Promise<void>((resolve) => {
        resolveSettlement = resolve;
      });
      queue = {
        entries: [],
        settlement,
        resolveSettlement,
        bytes: 0,
        draining: false,
        inFlight: false,
        timer: null,
      };
      this.#sessionProjectionQueues.set(target.paneId, queue);
    }

    const bytes = sessionEffectBytes(event.effect);
    const previousIndex = queue.entries.length - 1;
    const previous = previousIndex >= (queue.inFlight ? 1 : 0)
      ? queue.entries[previousIndex]
      : undefined;
    const previousEffect = previous?.event.effect;
    const coalesces = previous !== undefined &&
      previousEffect?.type === "delta_batch" &&
      event.effect.type === "delta_batch" &&
      previous.target.turnId === target.turnId &&
      sameSessionEvent(previous.event, event) &&
      previousEffect.channel === event.effect.channel &&
      previousEffect.assistantMessageId === event.effect.assistantMessageId &&
      previous.bytes + bytes <= MAX_COALESCED_DELTA_UTF8_BYTES;
    const additionalEntries = coalesces ? 0 : 1;
    const exceedsPaneCapacity =
      queue.entries.length + additionalEntries > MAX_SESSION_PROJECTION_EVENTS_PER_PANE ||
      queue.bytes + bytes > MAX_SESSION_PROJECTION_UTF8_BYTES_PER_PANE;
    if (exceedsPaneCapacity) {
      const containment = this.#containProjectionBacklogLoss(
        target,
        event.effect.type !== "terminal",
      );
      void containment.catch(() => undefined);
      return containment;
    }
    if (
      !this.#hasGlobalSessionProjectionCapacity(additionalEntries, bytes) &&
      !this.#reclaimGlobalSessionProjectionCapacity(
        additionalEntries,
        bytes,
        target.paneId,
      )
    ) {
      // Count pressure above the live-pane floor and byte pressure over the
      // queued-byte budget both imply a reclaimable owner. Keep this fail-
      // closed branch for accounting corruption or a future oversized effect.
      const containment = this.#containProjectionBacklogLoss(
        target,
        event.effect.type !== "terminal",
      );
      void containment.catch(() => undefined);
      return containment;
    }

    if (coalesces && previous !== undefined && previousEffect?.type === "delta_batch") {
      queue.entries[previousIndex] = {
        target: previous.target,
        bytes: previous.bytes + bytes,
        event: {
          ...previous.event,
          effect: {
            ...previousEffect,
            deltas: appendCoalescedStoreDeltas(
              previousEffect.deltas,
              event.effect.deltas,
            ),
          },
        },
      };
      queue.bytes += bytes;
      this.#sessionProjectionUtf8Bytes += bytes;
    } else {
      queue.entries.push({ event, target, bytes });
      queue.bytes += bytes;
      this.#sessionProjectionEventCount += 1;
      this.#sessionProjectionUtf8Bytes += bytes;
    }

    if (event.effect.type !== "delta_batch") {
      this.#startSessionProjectionDrain(target.paneId, queue);
      return queue.settlement;
    }
    if (this.#admissionClosed || queue.bytes >= MAX_COALESCED_DELTA_UTF8_BYTES) {
      this.#startSessionProjectionDrain(target.paneId, queue);
      return queue.settlement;
    }
    if (!queue.draining && queue.timer === null) {
      queue.timer = setTimeout(() => {
        queue.timer = null;
        this.#startSessionProjectionDrain(target.paneId, queue);
      }, DELTA_COALESCE_LATENCY_MILLISECONDS);
    }
    return queue.settlement;
  }

  #hasGlobalSessionProjectionCapacity(entries: number, bytes: number): boolean {
    return this.#earlySessionEventCount + this.#sessionProjectionEventCount + entries <=
        MAX_SESSION_PROJECTION_EVENTS_GLOBAL &&
      this.#earlySessionEventUtf8Bytes + this.#sessionProjectionUtf8Bytes -
          this.#sessionProjectionInFlightUtf8Bytes + bytes <=
        MAX_SESSION_PROJECTION_UTF8_BYTES_GLOBAL;
  }

  #reclaimGlobalSessionProjectionCapacity(
    entries: number,
    bytes: number,
    crossingPaneId: ChatPaneId,
  ): boolean {
    while (!this.#hasGlobalSessionProjectionCapacity(entries, bytes)) {
      const owner = this.#largestReclaimableSessionBacklog(crossingPaneId);
      if (owner === null) return false;
      const beforeEntries = this.#earlySessionEventCount + this.#sessionProjectionEventCount;
      const beforeBytes = this.#earlySessionEventUtf8Bytes +
        this.#sessionProjectionUtf8Bytes;
      if (owner.kind === "early") {
        this.#reclaimEarlySessionBacklog(owner.paneId);
      } else if (owner.target !== null) {
        void this.#containProjectionBacklogLoss(
          owner.target,
          owner.providerMayStillRun,
        ).catch(() => undefined);
      }
      if (
        beforeEntries === this.#earlySessionEventCount + this.#sessionProjectionEventCount &&
        beforeBytes === this.#earlySessionEventUtf8Bytes +
          this.#sessionProjectionUtf8Bytes
      ) return false;
    }
    return true;
  }

  #largestReclaimableSessionBacklog(
    crossingPaneId: ChatPaneId,
  ): ReclaimableSessionBacklog | null {
    const candidates: ReclaimableSessionBacklog[] = [];
    for (const [paneId, queue] of this.#sessionProjectionQueues) {
      if (paneId === crossingPaneId) continue;
      const start = queue.inFlight ? 1 : 0;
      const suffix = queue.entries.slice(start);
      const target = suffix[0]?.target ?? null;
      if (target === null) continue;
      candidates.push({
        paneId,
        kind: "projection",
        entries: suffix.length,
        bytes: suffix.reduce((total, entry) => total + entry.bytes, 0),
        target,
        providerMayStillRun: !queue.entries.some(
          (entry) => entry.target.turnId === target.turnId &&
            entry.event.effect.type === "terminal",
        ),
      });
    }
    for (const [paneId, paneBuffer] of this.#earlySessionEvents) {
      if (paneId === crossingPaneId || paneBuffer.eventCount === 0) continue;
      candidates.push({
        paneId,
        kind: "early",
        entries: paneBuffer.eventCount,
        bytes: paneBuffer.totalBytes,
        target: null,
        providerMayStillRun: true,
      });
    }
    return candidates.toSorted((left, right) => {
      const pressure = right.bytes - left.bytes || right.entries - left.entries;
      if (pressure !== 0) return pressure;
      return left.paneId < right.paneId ? -1 : left.paneId > right.paneId ? 1 : 0;
    })[0] ?? null;
  }

  #reclaimEarlySessionBacklog(paneId: ChatPaneId): void {
    const paneBuffer = this.#earlySessionEvents.get(paneId);
    if (paneBuffer === undefined || paneBuffer.eventCount === 0) return;
    this.#earlySessionEventCount -= paneBuffer.eventCount;
    this.#earlySessionEventUtf8Bytes -= paneBuffer.totalBytes;
    for (const buffer of paneBuffer.byKey.values()) {
      buffer.events.splice(0);
      buffer.bytes = 0;
      buffer.overflowed = true;
    }
    paneBuffer.eventCount = 0;
    paneBuffer.totalBytes = 0;
    paneBuffer.unknownOverflow = true;
  }

  #startSessionProjectionDrain(
    paneId: ChatPaneId,
    queue: SessionProjectionQueue,
  ): void {
    if (queue.draining || queue.entries.length === 0) return;
    if (queue.timer !== null) clearTimeout(queue.timer);
    queue.timer = null;
    queue.draining = true;
    const operation = this.#serialize(paneId, () =>
      this.#drainSessionProjectionQueue(paneId, queue));
    const finished = () => {
      queue.draining = false;
      queue.inFlight = false;
      if (this.#sessionProjectionQueues.get(paneId) !== queue) return;
      if (queue.entries.length === 0) {
        this.#sessionProjectionQueues.delete(paneId);
        queue.resolveSettlement();
        return;
      }
      if (this.#poisonedTurns.get(paneId) === queue.entries[0]?.target.turnId) {
        this.#discardSessionProjectionQueue(paneId);
        return;
      }
      this.#startSessionProjectionDrain(paneId, queue);
    };
    void operation.then(finished, finished);
  }

  async #drainSessionProjectionQueue(
    paneId: ChatPaneId,
    queue: SessionProjectionQueue,
  ): Promise<void> {
    while (queue.entries.length > 0) {
      const entry = queue.entries[0];
      if (entry === undefined) return;
      queue.inFlight = true;
      this.#sessionProjectionInFlightUtf8Bytes += entry.bytes;
      try {
        await this.#applySessionEventSafely(entry.target, entry.event);
      } catch {
        await this.#containProjectionBacklogLoss(
          entry.target,
          entry.event.effect.type !== "terminal",
        ).catch(() => undefined);
      } finally {
        this.#sessionProjectionInFlightUtf8Bytes -= entry.bytes;
        queue.inFlight = false;
        if (queue.entries[0] === entry) this.#releaseSessionProjectionEntry(queue);
      }
      if (this.#poisonedTurns.get(paneId) === entry.target.turnId) {
        this.#discardSessionProjectionQueue(paneId);
        return;
      }
    }
  }

  #releaseSessionProjectionEntry(queue: SessionProjectionQueue): void {
    const released = queue.entries.shift();
    if (released === undefined) return;
    queue.bytes -= released.bytes;
    this.#sessionProjectionEventCount -= 1;
    this.#sessionProjectionUtf8Bytes -= released.bytes;
  }

  #discardSessionProjectionQueue(
    paneId: ChatPaneId,
    resolveSettlement = false,
  ): void {
    const queue = this.#sessionProjectionQueues.get(paneId);
    if (queue === undefined) return;
    const exactTurnId = queue.entries[0]?.target.turnId;
    if (queue.timer !== null) clearTimeout(queue.timer);
    queue.timer = null;
    const retainedEntries = queue.inFlight ? 1 : 0;
    const discarded = queue.entries.splice(retainedEntries);
    const discardedBytes = discarded.reduce((total, entry) => total + entry.bytes, 0);
    queue.bytes -= discardedBytes;
    this.#sessionProjectionEventCount -= discarded.length;
    this.#sessionProjectionUtf8Bytes -= discardedBytes;
    if (
      resolveSettlement ||
      exactTurnId !== undefined &&
      this.#poisonedTurns.get(paneId) === exactTurnId
    ) queue.resolveSettlement();
    if (!queue.draining && queue.entries.length === 0) {
      this.#sessionProjectionQueues.delete(paneId);
      queue.resolveSettlement();
    }
  }

  #chatPaneForSessionEvent(
    accountProfileId: ChatAccountProfileId,
    providerThreadId: string,
    providerTurnId: string,
  ): ChatPanePrivateRecord | null {
    try {
      const direct = this.#store.findByProviderThread(
        accountProfileId,
        providerThreadId,
      );
      if (direct !== null) return direct;
      const paneId = this.#harnessActors?.routeSessionEvent({
        accountProfileId,
        threadId: providerThreadId,
        turnId: providerTurnId,
      }) ?? null;
      if (paneId === null) return null;
      const routed = this.#store.get(paneId);
      if (
        routed?.projection.interactionMode !== "harnessObserver" ||
        routed.binding?.accountProfileId !== accountProfileId ||
        routed.binding.threadId !== providerThreadId
      ) return null;
      return routed;
    } catch {
      return null;
    }
  }

  #bufferEarlySessionEvent(paneId: ChatPaneId, event: SessionEventEnvelope): void {
    const key = sessionEventKey(event);
    let paneBuffer = this.#earlySessionEvents.get(paneId);
    if (paneBuffer === undefined) {
      paneBuffer = {
        byKey: new Map(),
        overflowedKeys: new Set(),
        terminalKeys: new Set(),
        eventCount: 0,
        totalBytes: 0,
        unknownOverflow: false,
      };
      this.#earlySessionEvents.set(paneId, paneBuffer);
    }
    let buffer = paneBuffer.byKey.get(key);
    if (buffer === undefined) {
      if (paneBuffer.byKey.size >= MAX_EARLY_SESSION_EVENT_KEYS_PER_PANE) {
        if (paneBuffer.overflowedKeys.size < MAX_EARLY_SESSION_EVENT_KEYS_PER_PANE) {
          paneBuffer.overflowedKeys.add(key);
          if (
            event.effect.type === "terminal" &&
            paneBuffer.terminalKeys.size < MAX_EARLY_SESSION_EVENT_KEYS_PER_PANE * 2
          ) paneBuffer.terminalKeys.add(key);
        } else {
          paneBuffer.unknownOverflow = true;
        }
        return;
      }
      buffer = { events: [], bytes: 0, overflowed: false };
      paneBuffer.byKey.set(key, buffer);
    }
    if (
      event.effect.type === "terminal" &&
      paneBuffer.terminalKeys.size < MAX_EARLY_SESSION_EVENT_KEYS_PER_PANE * 2
    ) paneBuffer.terminalKeys.add(key);
    if (buffer.overflowed) return;
    const bytes = sessionEffectBytes(event.effect);
    const previous = buffer.events.at(-1);
    const coalesces = previous?.effect.type === "delta_batch" &&
      event.effect.type === "delta_batch" &&
      sameSessionEvent(previous, event) &&
      previous.effect.channel === event.effect.channel &&
      previous.effect.assistantMessageId === event.effect.assistantMessageId &&
      deltaBatchBytes(previous.effect) + bytes <= MAX_COALESCED_DELTA_UTF8_BYTES;
    const additionalEntries = coalesces ? 0 : 1;
    if (
      paneBuffer.eventCount + additionalEntries > MAX_EARLY_SESSION_EVENTS_PER_PANE ||
      paneBuffer.totalBytes + bytes > MAX_EARLY_SESSION_EVENT_UTF8_BYTES_PER_PANE
    ) {
      buffer.overflowed = true;
      return;
    }
    if (
      !this.#hasGlobalSessionProjectionCapacity(additionalEntries, bytes) &&
      !this.#reclaimGlobalSessionProjectionCapacity(
        additionalEntries,
        bytes,
        paneId,
      )
    ) {
      buffer.overflowed = true;
      return;
    }
    if (coalesces && previous?.effect.type === "delta_batch") {
      buffer.events[buffer.events.length - 1] = {
        ...previous,
        effect: {
          ...previous.effect,
          deltas: appendCoalescedStoreDeltas(
            previous.effect.deltas,
            event.effect.deltas,
          ),
        },
      };
      buffer.bytes += bytes;
      paneBuffer.totalBytes += bytes;
      this.#earlySessionEventUtf8Bytes += bytes;
      return;
    }
    buffer.events.push(event);
    buffer.bytes += bytes;
    paneBuffer.eventCount += 1;
    paneBuffer.totalBytes += bytes;
    this.#earlySessionEventCount += 1;
    this.#earlySessionEventUtf8Bytes += bytes;
  }

  #discardEarlySessionEvents(paneId: ChatPaneId): PaneEarlySessionEvents | undefined {
    const paneBuffer = this.#earlySessionEvents.get(paneId);
    if (paneBuffer === undefined) return undefined;
    this.#earlySessionEvents.delete(paneId);
    this.#earlySessionEventCount -= paneBuffer.eventCount;
    this.#earlySessionEventUtf8Bytes -= paneBuffer.totalBytes;
    return paneBuffer;
  }

  async #drainEarlySessionEvents(
    paneId: ChatPaneId,
    accountProfileId: ChatAccountProfileId,
    providerThreadId: string,
    providerTurnId: string,
  ): Promise<void> {
    const paneBuffer = this.#discardEarlySessionEvents(paneId);
    if (paneBuffer === undefined) return;
    const key = sessionEventKey({ accountProfileId, providerThreadId, providerTurnId });
    const exact = paneBuffer.byKey.get(key);
    if (
      paneBuffer.unknownOverflow ||
      paneBuffer.overflowedKeys.has(key) ||
      exact?.overflowed === true
    ) {
      const pane = this.#store.get(paneId);
      const logicalTurnId = pane?.projection.turn?.id;
      if (pane !== null && logicalTurnId !== undefined && activePane(pane.projection)) {
        await this.#containProjectionBacklogLoss(
          containmentTarget(pane),
          !paneBuffer.terminalKeys.has(key),
        );
      }
      return;
    }
    const pane = this.#store.get(paneId);
    if (
      pane === null ||
      pane.projection.turn === null ||
      pane.providerTurnId !== providerTurnId
    ) return;
    const target = containmentTarget(pane);
    for (const event of exact?.events ?? []) {
      void this.#admitSessionProjectionEvent(target, event).catch(() => undefined);
    }
  }

  async #applySessionEventSafely(
    target: TurnContainmentTarget,
    event: SessionEventEnvelope,
  ): Promise<void> {
    if (
      this.#poisonedTurns.get(target.paneId) === target.turnId ||
      this.#pendingTurnStops.get(target.paneId)?.turnId === target.turnId &&
        event.effect.type !== "terminal" ||
      this.#pendingTurnContainments.get(target.paneId)?.turnId === target.turnId &&
        event.effect.type !== "terminal"
    ) return;
    try {
      await this.#applySessionEvent(target.paneId, event);
    } catch {
      await this.#containProjectionBacklogLoss(
        target,
        event.effect.type !== "terminal",
      );
    }
  }

  async #applySessionEvent(
    paneId: ChatPaneId,
    event: SessionEventEnvelope,
  ): Promise<void> {
    const pane = this.#store.get(paneId);
    if (
      pane === null ||
      !activePane(pane.projection) ||
      pane.binding?.accountProfileId !== event.accountProfileId ||
      pane.binding.threadId !== event.providerThreadId ||
      pane.providerTurnId !== event.providerTurnId ||
      pane.projection.turn === null
    ) return;
    const turnId = pane.projection.turn.id;
    switch (event.effect.type) {
      case "delta_batch":
        await this.#applyDeltaBatch({
          paneId,
          turnId,
          channel: event.effect.channel,
          deltas: coalescedStoreDeltas(event.effect.deltas),
          ...(event.effect.assistantMessageId === undefined
            ? {}
            : { assistantMessageId: event.effect.assistantMessageId }),
        });
        return;
      case "assistant_completed": {
        const result = this.#store.reconcileAssistantCompletion({
          paneId,
          turnId,
          assistantMessageId: event.effect.assistantMessageId,
          fullText: event.effect.fullText,
          truncated: event.effect.truncated,
          now: this.#now(),
        });
        if (result.kind === "tainted") {
          throw new ChatPaneStoreError(
            "invalid_state",
            "The assistant completion did not match its durable stream.",
          );
        }
        if (result.kind === "repaired") {
          for (const delta of result.deltas) await this.#projection.delta(delta);
        }
        return;
      }
      case "tool_started":
        await this.#applyToolStarted({ paneId, turnId, category: "other" });
        return;
      case "tool_completed":
        await this.#applyToolCompleted({ paneId, turnId, category: "other" });
        return;
      case "tool_item_started": {
        if (!this.#rememberSessionItemEvent(paneId, event.effect)) return;
        const changed = this.#store.recordToolStarted(paneId, turnId, this.#now());
        if (changed !== null) {
          await this.#projection.paneStateChanged(changed);
        }
        return;
      }
      case "reasoning_item_completed": {
        if (!this.#rememberSessionItemEvent(paneId, event.effect)) return;
        const changed = this.#store.recordThinkingCompleted(paneId, turnId, this.#now());
        if (changed !== null) {
          await this.#projection.paneStateChanged(changed);
        }
        return;
      }
      case "unexpected_interaction":
        await this.#applyUnexpectedInteraction({ paneId, turnId });
        return;
      case "protocol_failure":
        throw new ChatPaneStoreError("conflict", "The provider stream was invalid.");
      case "terminal":
        {
          const lifecycle: SessionTurnLifecycle = {
            accountProfileId: event.accountProfileId,
            threadId: event.providerThreadId,
            turnId: event.providerTurnId,
            status: event.effect.outcome,
            ...(event.effect.quotaProof === undefined
              ? {}
              : { quotaProof: "provider_usage_limit_exceeded" as const }),
          };
          if (!this.#claimExactProviderTerminalForProjection(paneId, turnId, lifecycle)) {
            return;
          }
          try {
            await this.#applyTurnTerminal({
              paneId,
              turnId,
              outcome: event.effect.outcome,
              ...(event.effect.quotaProof === undefined
                ? {}
                : { quotaProof: event.effect.quotaProof }),
            }, lifecycle);
          } catch (error: unknown) {
            this.#releaseExactProviderTerminalProjectionClaim(paneId, turnId, lifecycle);
            throw error;
          }
          const retainedQuota = this.#priorQuotaTerminals.get(paneId);
          this.#resolveExactProviderTerminalWaiter(
            paneId,
            turnId,
            retainedQuota?.turnId === turnId ? retainedQuota.lifecycle : lifecycle,
          );
          return;
        }
    }
  }

  async #applyDelta(activity: ChatActivityDelta): Promise<void> {
    await this.#applyDeltaBatch({
      paneId: activity.paneId,
      turnId: activity.turnId,
      channel: activity.channel,
      deltas: [activity.delta],
      ...(activity.assistantMessageId === undefined
        ? {}
        : { assistantMessageId: activity.assistantMessageId }),
    });
  }

  async #applyDeltaBatch(input: Omit<ChatPaneDeltaBatchInput, "now">): Promise<void> {
    const result = await this.#persistDeltaBatch({ ...input, now: this.#now() });
    if (result === null) return;
    for (const delta of result.deltas) await this.#projection.delta(delta);
  }

  #persistDeltaBatch(
    input: ChatPaneDeltaBatchInput,
  ): Promise<ChatPaneDeltaBatchResult | null> {
    const bytes = input.deltas.reduce(
      (total, delta) => total + utf8ByteLength(delta),
      0,
    );
    return new Promise<ChatPaneDeltaBatchResult | null>((resolve, reject) => {
      this.#pendingStreamPersistence.push({ input, bytes, resolve, reject });
      this.#pendingStreamPersistenceUtf8Bytes += bytes;
      if (
        this.#admissionClosed ||
        bytes >= MAX_COALESCED_DELTA_UTF8_BYTES ||
        this.#pendingStreamPersistence.length >= MAX_STREAM_PERSISTENCE_REQUESTS ||
        this.#pendingStreamPersistenceUtf8Bytes >= MAX_STREAM_PERSISTENCE_UTF8_BYTES
      ) {
        this.#flushStreamPersistence();
        return;
      }
      if (this.#streamPersistenceTimer === null) {
        this.#streamPersistenceTimer = setTimeout(() => {
          this.#streamPersistenceTimer = null;
          this.#flushStreamPersistence();
        }, STREAM_PERSISTENCE_LATENCY_MILLISECONDS);
      }
    });
  }

  #flushStreamPersistence(): void {
    if (this.#streamPersistenceTimer !== null) {
      clearTimeout(this.#streamPersistenceTimer);
      this.#streamPersistenceTimer = null;
    }
    if (this.#pendingStreamPersistence.length === 0) return;
    const pending = this.#pendingStreamPersistence.splice(0);
    this.#pendingStreamPersistenceUtf8Bytes = 0;
    let outcomes: ReturnType<ChatPaneStore["appendDeltaBatches"]>;
    try {
      outcomes = this.#store.appendDeltaBatches(pending.map(({ input }) => input));
    } catch (error: unknown) {
      for (const request of pending) request.reject(error);
      return;
    }
    if (outcomes.length !== pending.length) {
      const error = new ChatPaneStoreError(
        "corrupt_state",
        "The durable chat stream batch returned an invalid result count.",
      );
      for (const request of pending) request.reject(error);
      return;
    }
    for (let index = 0; index < pending.length; index += 1) {
      const request = pending[index];
      const outcome = outcomes[index];
      if (request === undefined || outcome === undefined) continue;
      if (outcome.kind === "written") request.resolve(outcome.result);
      else request.reject(outcome.error);
    }
  }

  async #applyToolStarted(activity: ChatToolActivity): Promise<void> {
    const pane = this.#store.startTool(
      activity.paneId,
      activity.turnId,
      activity.category,
      this.#now(),
    );
    if (pane !== null) await this.#projection.paneStateChanged(pane);
  }

  async #applyToolCompleted(activity: ChatToolActivity): Promise<void> {
    const pane = this.#store.completeTool(
      activity.paneId,
      activity.turnId,
      activity.category,
      this.#now(),
    );
    if (pane !== null) await this.#projection.paneStateChanged(pane);
  }

  async #applyTurnTerminal(
    event: ChatTurnTerminal,
    lifecycle: SessionTurnLifecycle | null = null,
  ): Promise<void> {
    const pane = this.#store.get(event.paneId);
    if (pane?.projection.turn?.id !== event.turnId || !activePane(pane.projection)) return;
    if (pane.projection.interactionMode === "harnessObserver") {
      // A provider lifecycle notification is only a reconciliation hint for
      // an attached actor. Persistent actor authority owns terminal proof,
      // result bytes, quota handling, and any replacement incarnation. In
      // particular, never route this pane through ordinary chat failover.
      if (this.#admissionClosed) return;
      try {
        const outcome = await this.#startAttachedHarnessTurn(
          event.paneId,
          event.turnId,
          true,
        );
        if (outcome === "recovering") {
          this.#beginAttachedHarnessStartupRecovery(
            event.paneId,
            event.turnId,
            true,
            true,
          );
        } else {
          this.#clearAttachedHarnessStartupRetry(event.paneId, event.turnId);
        }
      } catch {
        // A provider scan or result read may be temporarily unavailable. Keep
        // the exact attached turn active and retry reconciliation. Generic
        // containment would poison the pane and discard the actor's eventual
        // exact result.
        this.#beginAttachedHarnessStartupRecovery(
          event.paneId,
          event.turnId,
          true,
          true,
        );
      }
      return;
    }
    const floor = this.#quotaProofFloors.get(event.paneId);
    const observedCurrentProof = event.outcome === "failed" &&
      floor?.turnId === event.turnId &&
      pane.binding?.accountProfileId === floor.accountProfileId &&
      this.#accounts.hasRateLimitProofSince?.(
        floor.accountProfileId,
        floor.cursor,
      ) === true;
    if (event.quotaProof === "provider_rate_limit_reached" || observedCurrentProof) {
      const quotaLifecycle = lifecycle === null
        ? null
        : Object.freeze({
            ...lifecycle,
            quotaProof: "provider_usage_limit_exceeded" as const,
          });
      if (quotaLifecycle !== null) {
        // Persist process-local root terminal authority before any await or
        // Stop check in continuation. The provider has already settled A;
        // even an immediately racing Stop must consume this exact fact rather
        // than interrupting A or synthesizing another terminal.
        this.#priorQuotaTerminals.set(event.paneId, Object.freeze({
          turnId: event.turnId,
          lifecycle: quotaLifecycle,
        }));
      }
      await this.#stopAfterProvenQuota(
        event.paneId,
        event.turnId,
        quotaLifecycle,
      );
      return;
    }
    if (lifecycle !== null) {
      await this.#observeHarnessTerminal(event.paneId, event.turnId, lifecycle);
    }
    if (event.outcome === "completed") {
      this.#quotaProofFloors.delete(event.paneId);
      this.#priorQuotaTerminals.delete(event.paneId);
      this.#discardEarlySessionEvents(event.paneId);
      this.#observedSessionItemEvents.delete(event.paneId);
      this.#attachedHarnessProjectionFences.delete(event.paneId);
      const completed = this.#store.completeTurn(event.paneId, event.turnId, this.#now());
      if (completed !== null) {
        await this.#projection.paneStateChanged(completed);
      }
      return;
    }
    await this.#publishAttention(event.paneId, event.turnId, {
      code: "turn_failed",
      message: event.outcome === "interrupted"
        ? "The turn was interrupted. You can send another message."
        : "The turn could not finish. You can send another message.",
      retryable: true,
    }, false);
  }

  async #applyUnexpectedInteraction(event: ChatUnexpectedInteraction): Promise<void> {
    const pane = this.#store.get(event.paneId);
    if (pane?.projection.turn?.id !== event.turnId || !activePane(pane.projection)) return;
    if (pane.projection.interactionMode === "harnessObserver") {
      // SessionService already rejects this interaction at the provider
      // boundary. The persistent actor owns any resulting cancellation,
      // terminal proof, and incarnation release; an ordinary chat interrupt
      // here would be an unjournaled second authority over the same turn.
      return;
    }
    const target = containmentTarget(pane);
    await this.#beginTurnContainment(target, !this.#admissionClosed, async () => {
      await this.#publishAttention(event.paneId, event.turnId, {
        code: "approval_required",
        message: "Codex requested an interaction that HRA cannot answer safely. Send another message to continue.",
        retryable: true,
      }, true);
    });
  }

  #beginExactProviderTerminalWait(
    target: TurnContainmentTarget,
  ): ExactProviderTerminalWaiter {
    if (target.binding === null || target.providerTurnId === null) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "An exact provider terminal wait requires accepted provider lineage.",
      );
    }
    const existing = this.#exactProviderTerminalWaiters.get(target.paneId);
    if (existing !== undefined) {
      if (
        existing.logicalTurnId === target.turnId &&
        existing.accountProfileId === target.binding.accountProfileId &&
        existing.providerThreadId === target.binding.threadId &&
        existing.providerTurnId === target.providerTurnId
      ) return existing;
      throw new ChatPaneStoreError(
        "conflict",
        "Another exact provider terminal wait already owns this pane.",
      );
    }
    let resolve!: (lifecycle: SessionTurnLifecycle) => void;
    const promise = new Promise<SessionTurnLifecycle>((resolvePromise) => {
      resolve = resolvePromise;
    });
    const waiter: ExactProviderTerminalWaiter = {
      paneId: target.paneId,
      logicalTurnId: target.turnId,
      accountProfileId: target.binding.accountProfileId,
      providerThreadId: target.binding.threadId,
      providerTurnId: target.providerTurnId,
      promise,
      resolve,
      interrupt: null,
    };
    this.#exactProviderTerminalWaiters.set(target.paneId, waiter);
    const receipt = this.#exactProviderTerminalReceipts.get(target.paneId);
    if (
      receipt?.owner === "unclaimed" &&
      receipt.logicalTurnId === target.turnId &&
      receipt.lifecycle.accountProfileId === waiter.accountProfileId &&
      receipt.lifecycle.threadId === waiter.providerThreadId &&
      receipt.lifecycle.turnId === waiter.providerTurnId
    ) {
      receipt.owner = "containment";
      this.#exactProviderTerminalWaiters.delete(target.paneId);
      waiter.interrupt = Promise.resolve();
      waiter.resolve(receipt.lifecycle);
    }
    return waiter;
  }

  #launchTrackedInterrupt(
    target: TurnContainmentTarget,
    waiter: ExactProviderTerminalWaiter,
  ): Promise<void> {
    if (waiter.interrupt !== null) return waiter.interrupt;
    if (target.binding === null || target.providerTurnId === null) {
      return Promise.resolve();
    }
    let initiated: Promise<void>;
    try {
      initiated = this.#provider.interruptTurn({
        ...target.binding,
        turnId: target.providerTurnId,
      });
    } catch (error: unknown) {
      initiated = Promise.reject(
        error instanceof Error ? error : new Error("Codex interrupt initiation failed."),
      );
    }
    // Track the RPC through its ACK deadline even when exact terminal proof
    // lets the pane stop immediately. After that deadline shutdown may
    // proceed, while this rejection observer remains attached for its lifetime.
    const effect = initiated.catch(() => undefined);
    waiter.interrupt = effect;
    this.#providerEffects.add(effect);
    const abandonTimer = setTimeout(() => {
      // The late RPC remains rejection-observed through `effect`, but after
      // the bounded ACK deadline it no longer owns shutdown/quiescence.
      this.#providerEffects.delete(effect);
    }, this.#interruptAckTimeoutMs);
    void effect.finally(() => {
      clearTimeout(abandonTimer);
      this.#providerEffects.delete(effect);
    });
    return effect;
  }

  async #awaitExactTerminalAfterInterrupt(
    waiter: ExactProviderTerminalWaiter,
    interrupt: Promise<void>,
  ): Promise<SessionTurnLifecycle | null> {
    const terminal = waiter.promise;
    let ackTimer: ReturnType<typeof setTimeout> | null = null;
    const ackDeadline = new Promise<null>((resolve) => {
      ackTimer = setTimeout(() => resolve(null), this.#interruptAckTimeoutMs);
    });
    const terminalBeforeInterrupt = await Promise.race([
      terminal,
      interrupt.then(() => null),
      ackDeadline,
    ]);
    if (ackTimer !== null) clearTimeout(ackTimer);
    if (terminalBeforeInterrupt !== null) return terminalBeforeInterrupt;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const graceExpired = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.#interruptTerminalGraceMs);
    });
    const terminalWithinGrace = await Promise.race([terminal, graceExpired]);
    if (timer !== null) clearTimeout(timer);
    if (terminalWithinGrace === null && this.#exactProviderTerminalWaiters.get(waiter.paneId) === waiter) {
      this.#exactProviderTerminalWaiters.delete(waiter.paneId);
    }
    return terminalWithinGrace;
  }

  #resolveExactProviderTerminalWaiter(
    paneId: ChatPaneId,
    logicalTurnId: ChatTurnId,
    lifecycle: SessionTurnLifecycle,
  ): void {
    const receipt = this.#exactProviderTerminalReceipts.get(paneId);
    if (
      receipt?.logicalTurnId === logicalTurnId &&
      receipt.lifecycle.accountProfileId === lifecycle.accountProfileId &&
      receipt.lifecycle.threadId === lifecycle.threadId &&
      receipt.lifecycle.turnId === lifecycle.turnId
    ) {
      this.#exactProviderTerminalReceipts.delete(paneId);
    }
    const waiter = this.#exactProviderTerminalWaiters.get(paneId);
    if (
      waiter === undefined ||
      waiter.logicalTurnId !== logicalTurnId ||
      waiter.accountProfileId !== lifecycle.accountProfileId ||
      waiter.providerThreadId !== lifecycle.threadId ||
      waiter.providerTurnId !== lifecycle.turnId
    ) return;
    const pane = this.#store.get(paneId);
    const retainedQuota = this.#priorQuotaTerminals.get(paneId);
    if (
      pane !== null &&
      pane.projection.turn?.id === logicalTurnId &&
      activePane(pane.projection) &&
      !(
        lifecycle.quotaProof === "provider_usage_limit_exceeded" &&
        retainedQuota?.turnId === logicalTurnId &&
        retainedQuota.lifecycle.accountProfileId === lifecycle.accountProfileId &&
        retainedQuota.lifecycle.threadId === lifecycle.threadId &&
        retainedQuota.lifecycle.turnId === lifecycle.turnId
      )
    ) return;
    this.#exactProviderTerminalWaiters.delete(paneId);
    waiter.resolve(lifecycle);
  }

  #recordExactProviderTerminalAtIngress(
    lifecycle: SessionTurnLifecycle,
  ): boolean {
    const current = this.#chatPaneForSessionEvent(
      lifecycle.accountProfileId,
      lifecycle.threadId,
      lifecycle.turnId,
    );
    if (
      current === null ||
      !activePane(current.projection) ||
      current.projection.turn === null ||
      current.binding?.accountProfileId !== lifecycle.accountProfileId ||
      current.binding.threadId !== lifecycle.threadId ||
      current.providerTurnId !== lifecycle.turnId
    ) return false;
    const paneId = current.projection.id;
    const logicalTurnId = current.projection.turn.id;
    const waiter = this.#exactProviderTerminalWaiters.get(paneId);
    if (
      waiter?.logicalTurnId === logicalTurnId &&
      waiter.accountProfileId === lifecycle.accountProfileId &&
      waiter.providerThreadId === lifecycle.threadId &&
      waiter.providerTurnId === lifecycle.turnId
    ) {
      this.#exactProviderTerminalWaiters.delete(paneId);
      waiter.resolve(lifecycle);
      return true;
    }
    const retained = this.#exactProviderTerminalReceipts.get(paneId);
    if (
      retained?.logicalTurnId === logicalTurnId &&
      retained.lifecycle.accountProfileId === lifecycle.accountProfileId &&
      retained.lifecycle.threadId === lifecycle.threadId &&
      retained.lifecycle.turnId === lifecycle.turnId
    ) return retained.owner === "containment";
    this.#exactProviderTerminalReceipts.set(paneId, {
      logicalTurnId,
      lifecycle: Object.freeze({ ...lifecycle }),
      owner: "unclaimed",
    });
    return false;
  }

  #claimExactProviderTerminalForProjection(
    paneId: ChatPaneId,
    logicalTurnId: ChatTurnId,
    lifecycle: SessionTurnLifecycle,
  ): boolean {
    const receipt = this.#exactProviderTerminalReceipts.get(paneId);
    if (
      receipt === undefined ||
      receipt.logicalTurnId !== logicalTurnId ||
      receipt.lifecycle.accountProfileId !== lifecycle.accountProfileId ||
      receipt.lifecycle.threadId !== lifecycle.threadId ||
      receipt.lifecycle.turnId !== lifecycle.turnId
    ) return true;
    if (receipt.owner === "containment") return false;
    receipt.owner = "projection";
    return true;
  }

  #releaseExactProviderTerminalProjectionClaim(
    paneId: ChatPaneId,
    logicalTurnId: ChatTurnId,
    lifecycle: SessionTurnLifecycle,
  ): void {
    const receipt = this.#exactProviderTerminalReceipts.get(paneId);
    if (
      receipt?.owner === "projection" &&
      receipt.logicalTurnId === logicalTurnId &&
      receipt.lifecycle.accountProfileId === lifecycle.accountProfileId &&
      receipt.lifecycle.threadId === lifecycle.threadId &&
      receipt.lifecycle.turnId === lifecycle.turnId
    ) receipt.owner = "unclaimed";
  }

  #requestTurnStop(
    command: Extract<ChatPaneCommand, { readonly type: "chat.turn.stop" }>,
  ): Promise<ChatPaneProjection> {
    const pane = this.#store.require(command.paneId);
    if (command.expectedRevision > pane.projection.revision) {
      throw new ChatPaneStoreError(
        "revision_conflict",
        "The stop request names a future chat pane revision.",
      );
    }
    if (pane.projection.interactionMode !== "chat") {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Persistent actor turns can be stopped only by their owning actor authority.",
      );
    }
    if (pane.projection.turn?.id !== command.turnId) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "This exact chat turn is no longer active.",
      );
    }
    const containment = this.#pendingTurnContainments.get(command.paneId);
    if (containment?.turnId === command.turnId) {
      return containment.promise.then(() => {
        const settled = this.#store.require(command.paneId).projection;
        if (settled.turn?.id === command.turnId && !activePane(settled)) return settled;
        throw new ChatPaneStoreError(
          "invalid_state",
          "The provider turn containment did not reach a reusable terminal state.",
        );
      });
    }
    const existing = this.#pendingTurnStops.get(command.paneId);
    if (existing !== undefined) {
      if (existing.turnId !== command.turnId) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "Another chat turn is already being stopped.",
        );
      }
      return existing.promise;
    }
    if (!activePane(pane.projection)) {
      if (
        pane.projection.revision > command.expectedRevision &&
        (pane.projection.state === "ready" || pane.projection.state === "attention")
      ) return Promise.resolve(pane.projection);
      throw new ChatPaneStoreError(
        "invalid_state",
        "This exact chat turn is no longer active.",
      );
    }

    let resolve!: (projection: ChatPaneProjection) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<ChatPaneProjection>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const request: PendingTurnStop = {
      turnId: command.turnId,
      promise,
      resolve,
      reject,
    };
    this.#pendingTurnStops.set(command.paneId, request);
    const effect = this.#driveTurnStop(command.paneId, request)
      .finally(() => {
        if (this.#pendingTurnStops.get(command.paneId) === request) {
          this.#pendingTurnStops.delete(command.paneId);
        }
      })
      .then(resolve, reject);
    this.#providerEffects.add(effect);
    void effect.finally(() => this.#providerEffects.delete(effect));
    return promise;
  }

  async #driveTurnStop(
    paneId: ChatPaneId,
    request: PendingTurnStop,
  ): Promise<ChatPaneProjection> {
    let pane = this.#store.require(paneId);
    if (pane.projection.turn?.id !== request.turnId) {
      throw new ChatPaneStoreError(
        "revision_conflict",
        "Another chat turn replaced the requested stop target.",
      );
    }
    if (!activePane(pane.projection)) return pane.projection;

    const target = containmentTarget(pane);
    let generationFenced = false;
    // Reservation is committed before any provider mutation. During an
    // account handoff, the previous binding can therefore name A while an
    // unresolved startThread already belongs to B.
    const accountProfileId = reservedContainmentAccount(pane, target);
    const priorQuota = this.#priorQuotaTerminals.get(paneId);
    let priorQuotaLifecycle = priorQuota?.turnId === request.turnId
      ? priorQuota.lifecycle
      : null;
    let exactTerminalLifecycle: SessionTurnLifecycle | null = null;
    const priorQuotaProvesCurrentAttemptTerminal = priorQuotaLifecycle !== null &&
      target.binding?.accountProfileId === priorQuotaLifecycle.accountProfileId &&
      target.binding.threadId === priorQuotaLifecycle.threadId &&
      target.providerTurnId === priorQuotaLifecycle.turnId &&
      accountProfileId === priorQuotaLifecycle.accountProfileId;

    if (
      !priorQuotaProvesCurrentAttemptTerminal &&
      target.binding !== null &&
      target.providerTurnId !== null
    ) {
      const terminalWaiter = this.#beginExactProviderTerminalWait(target);
      const interrupt = this.#launchTrackedInterrupt(target, terminalWaiter);
      const exactTerminal = await this.#awaitExactTerminalAfterInterrupt(
        terminalWaiter,
        interrupt,
      );
      pane = this.#store.require(paneId);
      if (pane.projection.turn?.id !== request.turnId) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "Another chat turn replaced the requested stop target.",
        );
      }
      if (!activePane(pane.projection)) return pane.projection;
      if (exactTerminal !== null) {
        exactTerminalLifecycle = exactTerminal;
        const retained = this.#priorQuotaTerminals.get(paneId);
        if (
          retained?.turnId === request.turnId &&
          retained.lifecycle.accountProfileId === exactTerminal.accountProfileId &&
          retained.lifecycle.threadId === exactTerminal.threadId &&
          retained.lifecycle.turnId === exactTerminal.turnId
        ) {
          priorQuotaLifecycle = retained.lifecycle;
        }
      } else {
        const receipt = this.#exactProviderTerminalReceipts.get(paneId);
        const exactProjectionOwnsTerminal =
          receipt?.owner === "projection" &&
          receipt.logicalTurnId === request.turnId &&
          target.binding !== null &&
          target.providerTurnId !== null &&
          receipt.lifecycle.accountProfileId === target.binding.accountProfileId &&
          receipt.lifecycle.threadId === target.binding.threadId &&
          receipt.lifecycle.turnId === target.providerTurnId &&
          accountProfileId === receipt.lifecycle.accountProfileId;
        if (exactProjectionOwnsTerminal) {
          // The provider is definitively terminal; only the local root/store
          // projection is wedged. Restart that boundary without invalidating
          // healthy sibling turns on the same account generation.
          this.#poisonTurnAndRequestRecovery({
            paneId,
            turnId: request.turnId,
            accountProfileId,
          });
          return this.#requireStoppedOrPoisonedPane(paneId, request.turnId);
        }
        generationFenced = true;
      }
    } else if (!priorQuotaProvesCurrentAttemptTerminal && accountProfileId !== null) {
      // Account reservation is durable before any provider thread mutation.
      // With no exact provider turn yet, fencing that generation is the only
      // proof that a late start response cannot create overlapping work.
      generationFenced = true;
    }

    if (generationFenced) {
      if (accountProfileId === null) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "An in-flight provider attempt lost its account generation.",
        );
      }
      try {
        await this.#containAccountGeneration(accountProfileId);
      } catch {
        this.#poisonTurnAndRequestRecovery({
          paneId,
          turnId: request.turnId,
          accountProfileId,
        });
        return this.#requireStoppedOrPoisonedPane(paneId, request.turnId);
      }
    }

    pane = this.#store.require(paneId);
    if (pane.projection.turn?.id !== request.turnId) {
      throw new ChatPaneStoreError(
        "revision_conflict",
        "Another chat turn replaced the requested stop target.",
      );
    }
    if (!activePane(pane.projection)) return pane.projection;

    try {
      if (priorQuotaLifecycle !== null) {
        this.#priorQuotaTerminals.delete(paneId);
        await this.#observeHarnessTerminal(paneId, request.turnId, priorQuotaLifecycle);
      } else if (exactTerminalLifecycle !== null) {
        await this.#observeHarnessTerminal(paneId, request.turnId, exactTerminalLifecycle);
      } else if (target.binding !== null && target.providerTurnId !== null) {
        await this.#observeHarnessTerminal(paneId, request.turnId, {
          accountProfileId: target.binding.accountProfileId,
          threadId: target.binding.threadId,
          turnId: target.providerTurnId,
          status: "interrupted",
        });
      } else {
        await this.#settleHarnessBeforeProvider(
          paneId,
          request.turnId,
          "provider_start_ambiguous",
        );
      }
    } catch {
      this.#poisonTurnAndRequestRecovery({
        paneId,
        turnId: request.turnId,
        accountProfileId,
      });
      return this.#requireStoppedOrPoisonedPane(paneId, request.turnId);
    }

    // An ingress terminal and its queued durable projection may race this
    // out-of-band Stop path. If that exact terminal committed while harness
    // settlement was draining, it already made the pane reusable and wins
    // without a synthetic second terminal transition.
    pane = this.#store.require(paneId);
    if (pane.projection.turn?.id !== request.turnId) {
      throw new ChatPaneStoreError(
        "revision_conflict",
        "Another chat turn replaced the requested stop target.",
      );
    }
    if (!activePane(pane.projection)) return pane.projection;

    const stopped = this.#store.enterAttention({
      paneId,
      turnId: request.turnId,
      attention: generationFenced
        ? {
            code: "runtime_unavailable",
            message: "HRA safely restarted the in-flight subscription before stopping this turn. You can send another message.",
            retryable: true,
          }
        : {
            code: "turn_failed",
            message: "You stopped this turn. You can send another message.",
            retryable: true,
          },
      clearBinding: generationFenced,
      now: this.#now(),
    });
    if (stopped === null) {
      throw new ChatPaneStoreError(
        "revision_conflict",
        "This exact chat turn settled before its stop request took effect.",
      );
    }
    this.#poisonedTurns.set(paneId, request.turnId);
    this.#attachedHarnessProjectionFences.delete(paneId);
    this.#discardSessionProjectionQueue(paneId);
    this.#exactProviderTerminalReceipts.delete(paneId);
    this.#discardEarlySessionEvents(paneId);
    this.#observedSessionItemEvents.delete(paneId);
    this.#quotaProofFloors.delete(paneId);
    // A generation fence makes any older provider-start tail causally dead.
    // Release new exact-turn commands from that tail; every late state write
    // remains fenced by the old logical turn ID and terminal pane state.
    this.#paneTails.delete(paneId);
    await this.#projection.paneStateChanged(stopped);
    if (generationFenced && accountProfileId !== null) {
      try {
        await this.handleAccountUnavailable(accountProfileId);
      } catch {
        this.#poisonTurnAndRequestRecovery({
          paneId,
          turnId: request.turnId,
          accountProfileId,
        });
      }
    }
    return this.#store.require(paneId).projection;
  }

  #turnStartupMustStop(paneId: ChatPaneId, turnId: ChatTurnId): boolean {
    if (
      this.#pendingTurnStops.get(paneId)?.turnId === turnId ||
      this.#pendingTurnContainments.get(paneId)?.turnId === turnId ||
      this.#poisonedTurns.get(paneId) === turnId ||
      this.#recoveryFencedTurns.get(paneId) === turnId
    ) return true;
    try {
      const pane = this.#store.get(paneId);
      return pane === null || pane.projection.interactionMode !== "chat" ||
        pane.projection.turn?.id !== turnId || !activePane(pane.projection);
    } catch {
      return true;
    }
  }

  #requireStoppedOrPoisonedPane(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
  ): ChatPaneProjection {
    const pane = this.#store.require(paneId).projection;
    if (pane.turn?.id !== turnId || activePane(pane)) {
      throw new ChatContainmentFailure();
    }
    this.#paneTails.delete(paneId);
    return pane;
  }

  #isExactAttachedHarnessProjectionFenced(
    target: TurnContainmentTarget,
  ): boolean {
    const fence = this.#attachedHarnessProjectionFences.get(target.paneId);
    return fence?.turnId === target.turnId &&
      fence.providerTurnId === target.providerTurnId;
  }

  #isAttachedHarnessTarget(target: TurnContainmentTarget): boolean {
    try {
      const pane = this.#store.get(target.paneId);
      return pane !== null &&
        pane.projection.interactionMode === "harnessObserver" &&
        pane.projection.turn?.id === target.turnId;
    } catch {
      return false;
    }
  }

  #containProjectionBacklogLoss(
    target: TurnContainmentTarget,
    providerMayStillRun: boolean,
  ): Promise<void> {
    if (this.#isAttachedHarnessTarget(target)) {
      this.#fenceAttachedHarnessProjection(target);
      return Promise.resolve();
    }
    return this.#beginPoisonExactTurn(target, providerMayStillRun);
  }

  #fenceAttachedHarnessProjection(target: TurnContainmentTarget): void {
    if (this.#isExactAttachedHarnessProjectionFenced(target)) return;
    this.#attachedHarnessProjectionFences.set(target.paneId, {
      turnId: target.turnId,
      providerTurnId: target.providerTurnId,
    });
    this.#discardSessionProjectionQueue(target.paneId, true);
    this.#discardEarlySessionEvents(target.paneId);
    this.#observedSessionItemEvents.delete(target.paneId);
    if (this.#admissionClosed) return;
    this.#beginAttachedHarnessStartupRecovery(
      target.paneId,
      target.turnId,
      true,
      false,
    );
  }

  async #beginPoisonExactTurn(
    target: TurnContainmentTarget,
    providerMayStillRun = !this.#admissionClosed,
  ): Promise<void> {
    await this.#beginTurnContainment(target, providerMayStillRun, async () => {
      try {
        this.#priorQuotaTerminals.delete(target.paneId);
        const poisoned = this.#store.poisonTurn(target.paneId, target.turnId, this.#now());
        if (poisoned !== null) await this.#projection.paneStateChanged(poisoned);
      } catch {
        // Memory fencing alone is not a recovery strategy. Ask the Native host
        // to rehydrate even when the fail-closed persistence write itself is
        // unavailable.
        this.#poisonActiveTurnAndRequestRecovery(target.paneId, target.turnId);
      }
    });
  }

  async #applyDirectWithContainment(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
    operation: () => void | Promise<void>,
    terminal = false,
  ): Promise<void> {
    if (
      this.#poisonedTurns.get(paneId) === turnId ||
      this.#pendingTurnStops.get(paneId)?.turnId === turnId && !terminal ||
      this.#pendingTurnContainments.get(paneId)?.turnId === turnId && !terminal
    ) return;
    let pane: ChatPanePrivateRecord | null;
    try {
      pane = this.#store.get(paneId);
    } catch {
      return;
    }
    if (
      pane === null ||
      pane.projection.turn?.id !== turnId ||
      !activePane(pane.projection)
    ) return;
    const target = containmentTarget(pane);
    try {
      await operation();
    } catch {
      await this.#beginPoisonExactTurn(target);
    }
  }

  async #beginTurnContainment(
    target: TurnContainmentTarget,
    providerMayStillRun: boolean,
    finalize: () => void | Promise<void>,
  ): Promise<void> {
    if (this.#poisonedTurns.get(target.paneId) === target.turnId) return;
    const existing = this.#pendingTurnContainments.get(target.paneId);
    if (existing?.turnId === target.turnId) return;
    let resolveContainment!: () => void;
    const containmentPromise = new Promise<void>((resolve) => {
      resolveContainment = resolve;
    });
    const containment: PendingTurnContainment = {
      turnId: target.turnId,
      promise: containmentPromise,
      resolve: resolveContainment,
    };
    this.#pendingTurnContainments.set(target.paneId, containment);
    this.#discardSessionProjectionQueue(target.paneId);
    this.#discardEarlySessionEvents(target.paneId);
    this.#quotaProofFloors.delete(target.paneId);

    if (!providerMayStillRun) {
      this.#poisonedTurns.set(target.paneId, target.turnId);
      this.#pendingTurnContainments.delete(target.paneId);
      try {
        try {
          await finalize();
        } catch {
          this.#poisonActiveTurnAndRequestRecovery(target.paneId, target.turnId);
        }
      } finally {
        containment.resolve();
      }
      return;
    }

    const exactTerminalWaiter = target.binding !== null && target.providerTurnId !== null
      ? this.#beginExactProviderTerminalWait(target)
      : null;
    const interrupt = exactTerminalWaiter === null
      ? Promise.resolve()
      : this.#launchTrackedInterrupt(target, exactTerminalWaiter);
    const effect = (async () => {
      if (exactTerminalWaiter !== null) {
        const terminal = await this.#awaitExactTerminalAfterInterrupt(
          exactTerminalWaiter,
          interrupt,
        );
        if (terminal !== null) {
          const priorQuota = this.#priorQuotaTerminals.get(target.paneId);
          const authoritativeLifecycle =
            priorQuota?.turnId === target.turnId &&
              priorQuota.lifecycle.accountProfileId === terminal.accountProfileId &&
              priorQuota.lifecycle.threadId === terminal.threadId &&
              priorQuota.lifecycle.turnId === terminal.turnId
              ? priorQuota.lifecycle
              : terminal;
          if (authoritativeLifecycle === priorQuota?.lifecycle) {
            this.#priorQuotaTerminals.delete(target.paneId);
          }
          try {
            await this.#observeHarnessTerminal(
              target.paneId,
              target.turnId,
              authoritativeLifecycle,
            );
          } catch {
            this.#poisonTurnAndRequestRecovery({
              paneId: target.paneId,
              turnId: target.turnId,
              accountProfileId: authoritativeLifecycle.accountProfileId,
            });
            return;
          }
          await this.#serialize(target.paneId, async () => {
            const current = this.#store.get(target.paneId);
            if (
              current === null ||
              current.projection.turn?.id !== target.turnId ||
              !activePane(current.projection)
            ) return;
            this.#poisonedTurns.set(target.paneId, target.turnId);
            try {
              await finalize();
            } catch {
              this.#poisonTurnAndRequestRecovery({
                paneId: target.paneId,
                turnId: target.turnId,
                accountProfileId: authoritativeLifecycle.accountProfileId,
              });
            }
          });
          return;
        }
      }
      let pane = this.#store.get(target.paneId);
      if (
        pane === null ||
        pane.projection.turn?.id !== target.turnId ||
        !activePane(pane.projection)
      ) return;
      const accountProfileId = reservedContainmentAccount(pane, target);
      if (accountProfileId === null) {
        await this.#serialize(target.paneId, async () => {
          const current = this.#store.get(target.paneId);
          if (
            current === null ||
            current.projection.turn?.id !== target.turnId ||
            !activePane(current.projection)
          ) return;
          this.#poisonedTurns.set(target.paneId, target.turnId);
          try {
            await finalize();
          } catch {
            this.#poisonTurnAndRequestRecovery({
              paneId: target.paneId,
              turnId: target.turnId,
              accountProfileId: null,
            });
          }
        });
        return;
      }
      try {
        await this.#containAccountGeneration(accountProfileId);
      } catch {
        pane = this.#store.get(target.paneId);
        if (
          pane !== null &&
          pane.projection.turn?.id === target.turnId &&
          activePane(pane.projection)
        ) {
          this.#poisonTurnAndRequestRecovery({
            paneId: target.paneId,
            turnId: target.turnId,
            accountProfileId,
          });
        }
        return;
      }
      await this.#serialize(target.paneId, async () => {
        const current = this.#store.get(target.paneId);
        if (
          current === null ||
          current.projection.turn?.id !== target.turnId ||
          !activePane(current.projection)
        ) return;
        this.#poisonedTurns.set(target.paneId, target.turnId);
        try {
          await finalize();
        } catch {
          this.#poisonTurnAndRequestRecovery({
            paneId: target.paneId,
            turnId: target.turnId,
            accountProfileId,
          });
        }
      });
      // Finalize the exact target before the account-wide callback can project
      // a broader account_unavailable transition over its authoritative
      // poison/attention reason. Peers are detached after the same fence.
      try {
        await this.handleAccountUnavailable(accountProfileId);
      } catch {
        this.#poisonTurnAndRequestRecovery({
          paneId: target.paneId,
          turnId: target.turnId,
          accountProfileId,
        });
      }
    })().catch(() => {
      this.#poisonActiveTurnAndRequestRecovery(target.paneId, target.turnId);
    }).finally(() => {
      if (this.#pendingTurnContainments.get(target.paneId) === containment) {
        this.#pendingTurnContainments.delete(target.paneId);
      }
      containment.resolve();
    });
    this.#providerEffects.add(effect);
    void effect.finally(() => this.#providerEffects.delete(effect));
  }

  async #escalateUnfencedTurn(
    target: TurnContainmentTarget,
    mode: "enqueue" | "already_serialized" = "enqueue",
  ): Promise<void> {
    if (target.binding === null) return;
    if (mode === "already_serialized") {
      this.#poisonUnfencedTurnAndRequestRecovery(target);
      return;
    }
    await this.#serialize(target.paneId, () => {
      this.#poisonUnfencedTurnAndRequestRecovery(target);
    });
  }

  #poisonUnfencedTurnAndRequestRecovery(target: TurnContainmentTarget): void {
    if (target.binding === null) return;
    this.#poisonTurnAndRequestRecovery({
      paneId: target.paneId,
      turnId: target.turnId,
      accountProfileId: target.binding.accountProfileId,
    });
  }

  #poisonActiveTurnAndRequestRecovery(paneId: ChatPaneId, turnId: ChatTurnId): void {
    let accountProfileId: ChatAccountProfileId | null = null;
    try {
      const pane = this.#store.get(paneId);
      if (
        pane === null ||
        pane.projection.turn?.id !== turnId ||
        !activePane(pane.projection)
      ) return;
      const target = containmentTarget(pane);
      accountProfileId = reservedContainmentAccount(pane, target);
    } catch {
      // A failed durable read is itself enough to require host rehydration.
    }
    this.#poisonTurnAndRequestRecovery({ paneId, turnId, accountProfileId });
  }

  #poisonTurnAndRequestRecovery(input: Readonly<{
    readonly paneId: ChatPaneId;
    readonly turnId: ChatTurnId;
    readonly accountProfileId: ChatAccountProfileId | null;
  }>): void {
    if (this.#recoveryFencedTurns.has(input.paneId)) return;
    this.#recoveryFencedTurns.set(input.paneId, input.turnId);
    this.#poisonedTurns.set(input.paneId, input.turnId);
    this.#discardSessionProjectionQueue(input.paneId);
    this.#exactProviderTerminalReceipts.delete(input.paneId);
    this.#discardEarlySessionEvents(input.paneId);
    this.#quotaProofFloors.delete(input.paneId);
    this.#priorQuotaTerminals.delete(input.paneId);
    try {
      const poisoned = this.#store.poisonTurn(input.paneId, input.turnId, this.#now());
      if (poisoned !== null) {
        try {
          // Start the best-effort live projection without letting a wedged
          // renderer delay the host recovery request. The durable snapshot
          // is the rehydration authority after transport replacement.
          void Promise.resolve(this.#projection.paneStateChanged(poisoned))
            .catch(() => undefined);
        } catch {
          // A synchronous projection failure is equivalent to an unavailable
          // renderer here; the durable snapshot remains authoritative.
        }
      }
    } catch {
      // The recovery request remains mandatory even when local persistence
      // is unavailable. Startup recovery will fail closed over any active row.
    }
    try {
      this.#runtimeRecovery.requestRecovery({
        reason: "ambiguous_provider_effect_unfenced",
        accountProfileId: input.accountProfileId,
        paneId: input.paneId,
        turnId: input.turnId,
      });
    } catch {
      // The durable attention state remains visible and same-process admission
      // stays fenced. A manual host restart is still a safe recovery path.
    }
  }

  async #startAttachedHarnessTurn(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
    reconcile = false,
  ): Promise<AttachedHarnessAttemptResult> {
    const actors = this.#harnessActors;
    if (actors === null) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Persistent actor messaging is unavailable.",
      );
    }
    const pane = this.#store.require(paneId);
    if (
      pane.projection.interactionMode !== "harnessObserver" ||
      pane.projection.turn?.id !== turnId ||
      !activePane(pane.projection) || pane.activePrompt === null
    ) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The attached actor turn is no longer active.",
      );
    }
    const request = {
      paneId,
      chatTurnId: turnId,
      prompt: pane.activePrompt,
      createdAt: pane.projection.turn.startedAt,
    } as const;
    let outcome: Awaited<ReturnType<ChatHarnessActorTurnPort["startTurn"]>>;
    try {
      outcome = await this.#awaitHarnessActorTransition(reconcile
        ? actors.reconcileTurn(request)
        : actors.startTurn(request));
    } catch (error: unknown) {
      if (error instanceof ChatHarnessActorTransitionTimeout) {
        // Actor identity is durable and its commands are exact-turn
        // idempotent. Keep the turn active for reconciliation while asking the
        // host to replace the wedged renderer/gateway boundary.
        this.#requestAttachedHarnessRuntimeRecovery(paneId, turnId);
        return "recovering";
      }
      throw error;
    }
    this.#attachedHarnessRecoveryRequestedTurns.delete(paneId);
    const current = this.#store.get(paneId);
    if (
      current === null ||
      current.projection.interactionMode !== "harnessObserver" ||
      current.projection.turn?.id !== turnId ||
      current.projection.turn.startedAt !== request.createdAt ||
      current.activePrompt !== request.prompt ||
      !activePane(current.projection)
    ) return "stale";
    if (outcome.kind === "recovering") return "recovering";
    if (outcome.kind === "settled") {
      if (outcome.outcome === "succeeded") {
        if (outcome.responseMarkdown === null) {
          await this.#publishAttention(paneId, turnId, {
            code: "runtime_unavailable",
            message: "The actor completed, but its response is not available yet. You can send another message.",
            retryable: true,
          }, false);
          return "resolved";
        }
        const completed = this.#store.completeAttachedHarnessTurn({
          paneId,
          turnId,
          markdown: outcome.responseMarkdown,
          now: this.#now(),
        });
        this.#attachedHarnessProjectionFences.delete(paneId);
        this.#quotaProofFloors.delete(paneId);
        this.#discardEarlySessionEvents(paneId);
        this.#observedSessionItemEvents.delete(paneId);
        if (completed !== null) {
          await this.#projection.paneStateChanged(completed);
        }
        return "resolved";
      }
      const attention = outcome.outcome === "quotaRejected"
        ? {
            code: "all_accounts_exhausted" as const,
            message: "Every eligible Codex subscription is at its usage limit. You can send another message later.",
            retryable: true,
          }
        : {
            code: "turn_failed" as const,
            message: outcome.outcome === "cancelled"
              ? "The actor turn was cancelled before Codex started. You can send another message."
              : "The actor turn could not start. You can send another message.",
            retryable: true,
          };
      await this.#publishAttention(paneId, turnId, attention, false);
      return "resolved";
    }
    if (current.binding === null) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The attached actor pane lost its exact provider thread.",
      );
    }
    if (current.providerTurnId === outcome.providerTurnId) return "resolved";
    const fence = this.#attachedHarnessProjectionFences.get(paneId);
    if (
      fence?.turnId === turnId &&
      fence.providerTurnId !== null &&
      fence.providerTurnId !== outcome.providerTurnId
    ) this.#attachedHarnessProjectionFences.delete(paneId);
    const streaming = this.#store.markTurnAccepted(
      paneId,
      turnId,
      outcome.providerTurnId,
      this.#now(),
    );
    await this.#projection.paneStateChanged(streaming);
    await this.#drainEarlySessionEvents(
      paneId,
      current.binding.accountProfileId,
      current.binding.threadId,
      outcome.providerTurnId,
    );
    return "resolved";
  }

  async #awaitHarnessActorTransition<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new ChatHarnessActorTransitionTimeout()),
        this.#harnessActorTransitionTimeoutMs,
      );
    });
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  #requestAttachedHarnessRuntimeRecovery(paneId: ChatPaneId, turnId: ChatTurnId): void {
    if (this.#attachedHarnessRecoveryRequestedTurns.get(paneId) === turnId) return;
    this.#attachedHarnessRecoveryRequestedTurns.set(paneId, turnId);
    let accountProfileId: ChatAccountProfileId | null = null;
    try {
      accountProfileId = this.#store.get(paneId)?.binding?.accountProfileId ?? null;
    } catch {
      // Native rehydration remains necessary when the durable read is wedged.
    }
    try {
      this.#runtimeRecovery.requestRecovery({
        reason: "ambiguous_provider_effect_unfenced",
        accountProfileId,
        paneId,
        turnId,
      });
    } catch {
      // The exact durable actor turn remains active for manual restart and the
      // bounded reconciliation loop no longer owns the pane tail.
    }
  }

  async #startLogicalTurn(paneId: ChatPaneId, turnId: ChatTurnId): Promise<void> {
    if (this.#turnStartupMustStop(paneId, turnId)) return;
    let pane = this.#store.require(paneId);
    const repository = await this.#resolveActiveRepository(pane, turnId);
    if (repository === null) return;
    if (this.#turnStartupMustStop(paneId, turnId)) return;
    await this.#admitHarnessRoot(pane, repository, turnId);
    if (this.#turnStartupMustStop(paneId, turnId)) return;
    let candidates: readonly ChatAccountCandidate[];
    try {
      candidates = await this.#accounts.refreshCandidates();
    } catch {
      if (this.#turnStartupMustStop(paneId, turnId)) return;
      await this.#settleHarnessBeforeProvider(
        paneId,
        turnId,
        "provider_unavailable",
      );
      await this.#publishAttention(paneId, turnId, {
        code: "account_unavailable",
        message: "Codex account availability could not be refreshed. Try again.",
        retryable: true,
      }, false);
      return;
    }
    if (this.#turnStartupMustStop(paneId, turnId)) return;
    pane = this.#store.require(paneId);
    const ranked = rankChatAccountCandidates(
      candidates,
      pane.projection.accountProfileId,
      pane.visitedAccountProfileIds,
    );
    const account = ranked[0];
    if (account === undefined) {
      if (this.#turnStartupMustStop(paneId, turnId)) return;
      await this.#settleHarnessBeforeProvider(
        paneId,
        turnId,
        "provider_unavailable",
      );
      await this.#publishNoAccountAttention(pane, candidates, turnId);
      return;
    }
    if (this.#turnStartupMustStop(paneId, turnId)) return;
    const previousBinding = pane.binding;
    const reserved = this.#store.reserveAccount(paneId, turnId, account.id, this.#now());
    await this.#projection.paneStateChanged(reserved);
    if (this.#turnStartupMustStop(paneId, turnId)) return;
    pane = this.#store.require(paneId);
    const configuration = configurationFor(pane);
    const plannedHandoff = previousBinding?.accountProfileId === account.id
      ? null
      : this.#store.handoffHistory(paneId, false);
    if (plannedHandoff !== null && !plannedHandoff.complete) {
      await this.#publishContextReset(paneId, turnId);
      return;
    }
    const handoffRequired = plannedHandoff !== null && plannedHandoff.items.length > 0;
    let handoffConfirmed = !handoffRequired;
    let providerTurnAttempted = false;
    try {
      if (this.#turnStartupMustStop(paneId, turnId)) return;
      await this.#provider.validateConfiguration(
        account.id,
        CHAT_MODEL,
        pane.projection.reasoningEffort,
        pane.projection.serviceTier,
      );
      if (this.#turnStartupMustStop(paneId, turnId)) return;
      let binding: ChatThreadBinding;
      if (previousBinding?.accountProfileId === account.id) {
        binding = previousBinding;
        if (this.#turnStartupMustStop(paneId, turnId)) return;
        await this.#provider.resumeThread({
          ...configuration,
          ...binding,
          title: pane.projection.title,
          workingDirectory: repository.workingDirectory,
        });
        if (this.#turnStartupMustStop(paneId, turnId)) return;
      } else {
        if (this.#turnStartupMustStop(paneId, turnId)) return;
        const started = await this.#provider.startThread({
          ...configuration,
          accountProfileId: account.id,
          title: pane.projection.title,
          workingDirectory: repository.workingDirectory,
        });
        if (this.#turnStartupMustStop(paneId, turnId)) return;
        binding = {
          accountProfileId: account.id,
          threadId: started.threadId,
          restartThreadId: started.restartThreadId,
        };
        const prepared = this.#store.prepareProviderThread(paneId, turnId, binding, this.#now());
        await this.#projection.paneStateChanged(prepared);
        if (this.#turnStartupMustStop(paneId, turnId)) return;
        await this.#tryName(binding, pane.projection.title);
        if (this.#turnStartupMustStop(paneId, turnId)) return;
        const history = plannedHandoff ?? this.#store.handoffHistory(paneId, false);
        if (!history.complete) {
          throw new ChatProviderEffectError({ certainty: "not_applied", code: "rejected" });
        }
        if (history.items.length > 0) {
          if (this.#turnStartupMustStop(paneId, turnId)) return;
          await this.#provider.injectHistory(binding, history.items);
          if (this.#turnStartupMustStop(paneId, turnId)) return;
        }
        handoffConfirmed = true;
      }
      if (previousBinding?.accountProfileId === account.id) {
        if (this.#turnStartupMustStop(paneId, turnId)) return;
        const prepared = this.#store.prepareProviderThread(paneId, turnId, binding, this.#now());
        await this.#projection.paneStateChanged(prepared);
        if (this.#turnStartupMustStop(paneId, turnId)) return;
      }
      const current = this.#store.require(paneId);
      const prompt = current.activePrompt;
      if (prompt === null) throw new ChatProviderEffectError({ certainty: "ambiguous", code: "unknown" });
      if (this.#turnStartupMustStop(paneId, turnId)) return;
      providerTurnAttempted = true;
      const accepted = await this.#startProviderTurn(
        {
          ...configuration,
          ...binding,
          clientTurnId: turnId,
          prompt,
          workingDirectory: repository.workingDirectory,
        },
        { paneId, turnId, binding, providerTurnId: null },
      );
      if (this.#turnStartupMustStop(paneId, turnId)) return;
      try {
        this.#rememberQuotaFloor(paneId, turnId, binding.accountProfileId, accepted.quotaProofCursor);
        const streaming = this.#store.markTurnAccepted(paneId, turnId, accepted.turnId, this.#now());
        await this.#projection.paneStateChanged(streaming);
        await this.#drainEarlySessionEvents(
          paneId,
          binding.accountProfileId,
          binding.threadId,
          accepted.turnId,
        );
      } catch {
        await this.#beginPoisonExactTurn({
          paneId,
          turnId,
          binding,
          providerTurnId: accepted.turnId,
        });
        throw new ChatContainmentFailure();
      }
    } catch (error: unknown) {
      if (error instanceof ChatContainmentFailure) {
        if (providerTurnAttempted) {
          try {
            await this.#settleHarnessBeforeProvider(
              paneId,
              turnId,
              "provider_start_ambiguous",
            );
          } catch {
            // Recovery was synchronously requested by the root boundary.
          }
        }
        return;
      }
      if (this.#turnStartupMustStop(paneId, turnId)) return;
      if (provenQuotaRejection(error)) {
        await this.#stopAfterProvenQuota(paneId, turnId, null);
        return;
      }
      await this.#settleHarnessBeforeProvider(
        paneId,
        turnId,
        providerTurnAttempted && ambiguousProviderEffect(error)
          ? "provider_start_ambiguous"
          : "provider_unavailable",
      );
      await this.#publishProviderFailure(
        paneId,
        turnId,
        error,
        handoffRequired && !handoffConfirmed ? "continuation_failed" : "turn_failed",
      );
    }
  }

  async #stopAfterProvenQuota(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
    priorQuotaLifecycle: SessionTurnLifecycle | null,
  ): Promise<void> {
    const pane = this.#store.get(paneId);
    if (pane?.projection.turn?.id !== turnId || !activePane(pane.projection)) return;
    if (priorQuotaLifecycle !== null) {
      // Retain the provider's exact terminal fact before root settlement. Stop
      // may race this await, but neither path may synthesize another terminal.
      this.#priorQuotaTerminals.set(paneId, Object.freeze({
        turnId,
        lifecycle: priorQuotaLifecycle,
      }));
    }
    await this.#settleHarnessAfterExhaustedQuota(
      paneId,
      turnId,
      priorQuotaLifecycle,
    );
    await this.#publishAttention(paneId, turnId, {
      code: "all_accounts_exhausted",
      message: "This Codex subscription reached its provider usage limit, so the turn stopped. You can send a new message later.",
      retryable: true,
    }, true);
  }

  async #startProviderTurn(
    request: Parameters<ChatProviderPort["startTurn"]>[0],
    target: TurnContainmentTarget,
  ): Promise<Awaited<ReturnType<ChatProviderPort["startTurn"]>>> {
    try {
      return await this.#provider.startTurn(request);
    } catch (error: unknown) {
      if (!ambiguousProviderEffect(error)) throw error;
      try {
        await this.#containAccountGeneration(request.accountProfileId);
      } catch {
        // This method runs inside the pane's serialization tail. Persist the
        // terminal poison and synchronously request Native recovery without
        // recursively enqueueing behind the tail that currently owns it.
        await this.#escalateUnfencedTurn(target, "already_serialized");
        throw new ChatContainmentFailure();
      }
      // The account-wide fence invalidates every concurrent provider turn on
      // that generation. Admit their pane detachments without recursively
      // awaiting this pane's own serialization tail.
      void this.handleAccountUnavailable(request.accountProfileId).catch(() => undefined);
      throw error;
    }
  }

  async #resolveActiveRepository(
    pane: ChatPanePrivateRecord,
    turnId: ChatTurnId,
  ): Promise<ChatRepository | null> {
    try {
      const source = await this.#repositories.resolve(pane.projection.repository.id);
      if (source !== null && source.id === pane.projection.repository.id) {
        const repository = await this.#workspaces.resolve(
          pane.projection.id,
          source,
        );
        if (repository !== null && repository.id === pane.projection.repository.id) {
          return repository;
        }
      }
    } catch {
      // Project a provider-neutral unavailable state below.
    }
    await this.#publishAttention(pane.projection.id, turnId, {
      code: "runtime_unavailable",
      message: "This repository is unavailable. Restore it, then send another message.",
      retryable: true,
    }, true);
    return null;
  }

  async #admitHarnessRoot(
    pane: ChatPanePrivateRecord,
    repository: ChatRepository,
    turnId: ChatTurnId,
  ): Promise<void> {
    const roots = this.#harnessRoots;
    if (roots === null) return;
    const turn = pane.projection.turn;
    const prompt = pane.activePrompt;
    if (
      turn === null || turn.id !== turnId || prompt === null ||
      pane.projection.repository.id !== repository.id
    ) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The chat turn is not ready for root harness admission.",
      );
    }
    let admitted: Awaited<ReturnType<ChatHarnessRootPort["admit"]>>;
    try {
      admitted = await this.#awaitHarnessRootTransition(roots.admit({
        repositoryId: repository.id,
        canonicalWorkingDirectory: repository.workingDirectory,
        paneId: pane.projection.id,
        chatTurnId: turnId,
        title: pane.projection.title,
        prompt,
        createdAt: turn.startedAt,
      }));
    } catch {
      this.#poisonActiveTurnAndRequestRecovery(pane.projection.id, turnId);
      throw new ChatContainmentFailure();
    }
    if (admitted === null) return;
    if (
      admitted.turnId.length === 0 || admitted.turnId.length > 96 ||
      admitted.turnId.includes("\0")
    ) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "Root harness admission returned an invalid logical turn identity.",
      );
    }
    if (
      this.#admissionClosed ||
      this.#turnStartupMustStop(pane.projection.id, turnId)
    ) {
      try {
        await this.#awaitHarnessRootTransition(roots.settleBeforeProvider({
          turnId: admitted.turnId,
          paneId: pane.projection.id,
          failure: "provider_start_ambiguous",
          settledAt: this.#now().toISOString(),
        }));
      } catch {
        this.#poisonTurnAndRequestRecovery({
          paneId: pane.projection.id,
          turnId,
          accountProfileId: null,
        });
      }
      return;
    }
    const current = this.#harnessRootTurns.get(pane.projection.id);
    if (
      current !== undefined &&
      (current.chatTurnId !== turnId || current.rootTurnId !== admitted.turnId)
    ) {
      try {
        await this.#awaitHarnessRootTransition(roots.settleBeforeProvider({
          turnId: admitted.turnId,
          paneId: pane.projection.id,
          failure: "provider_start_ambiguous",
          settledAt: this.#now().toISOString(),
        }));
      } catch {
        // Native recovery below owns both unresolved root identities.
      }
      this.#poisonActiveTurnAndRequestRecovery(pane.projection.id, turnId);
      throw new ChatContainmentFailure();
    }
    this.#harnessRootTurns.set(pane.projection.id, Object.freeze({
      chatTurnId: turnId,
      rootTurnId: admitted.turnId,
    }));
  }

  async #settleHarnessBeforeProvider(
    paneId: ChatPaneId,
    chatTurnId: ChatTurnId,
    failure: "provider_start_ambiguous" | "provider_unavailable",
  ): Promise<void> {
    const roots = this.#harnessRoots;
    const binding = this.#harnessRootTurns.get(paneId);
    if (roots === null || binding === undefined) return;
    if (binding.chatTurnId !== chatTurnId) {
      const pane = this.#store.get(paneId);
      if (
        pane?.projection.turn?.id === chatTurnId &&
        activePane(pane.projection)
      ) {
        this.#poisonActiveTurnAndRequestRecovery(paneId, chatTurnId);
        throw new ChatContainmentFailure();
      }
      return;
    }
    try {
      await this.#awaitHarnessRootTransition(roots.settleBeforeProvider({
        turnId: binding.rootTurnId,
        paneId,
        failure,
        settledAt: this.#now().toISOString(),
      }));
    } catch {
      this.#poisonActiveTurnAndRequestRecovery(paneId, chatTurnId);
      throw new ChatContainmentFailure();
    }
    if (this.#harnessRootTurns.get(paneId) === binding) {
      this.#harnessRootTurns.delete(paneId);
    }
  }

  async #observeHarnessTerminal(
    paneId: ChatPaneId,
    chatTurnId: ChatTurnId,
    lifecycle: SessionTurnLifecycle,
  ): Promise<void> {
    const roots = this.#harnessRoots;
    const binding = this.#harnessRootTurns.get(paneId);
    if (roots === null || binding === undefined) return;
    if (binding.chatTurnId !== chatTurnId) {
      const pane = this.#store.get(paneId);
      if (
        pane?.projection.turn?.id === chatTurnId &&
        activePane(pane.projection)
      ) {
        this.#poisonActiveTurnAndRequestRecovery(paneId, chatTurnId);
        throw new ChatContainmentFailure();
      }
      return;
    }
    try {
      await this.#awaitHarnessRootTransition(roots.observe(lifecycle));
    } catch {
      this.#poisonActiveTurnAndRequestRecovery(paneId, chatTurnId);
      throw new ChatContainmentFailure();
    }
    if (this.#harnessRootTurns.get(paneId) === binding) {
      this.#harnessRootTurns.delete(paneId);
    }
  }

  async #awaitHarnessRootTransition<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new ChatContainmentFailure()),
        this.#harnessRootTransitionTimeoutMs,
      );
    });
    try {
      // Promise.race retains rejection handlers on the losing operation, so a
      // late root-port rejection is observed after the bounded deadline. The
      // caller alone owns binding deletion and therefore cannot delete a newer
      // root identity when the abandoned operation eventually settles.
      return await Promise.race([operation, deadline]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  async #containAccountGeneration(accountProfileId: ChatAccountProfileId): Promise<void> {
    const operation = this.#accounts.containAmbiguousEffect(accountProfileId);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new ChatContainmentFailure()),
        this.#accountContainmentTimeoutMs,
      );
    });
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  async #settleHarnessAfterExhaustedQuota(
    paneId: ChatPaneId,
    chatTurnId: ChatTurnId,
    priorQuotaLifecycle: SessionTurnLifecycle | null,
  ): Promise<void> {
    const retained = this.#priorQuotaTerminals.get(paneId);
    const lifecycle = priorQuotaLifecycle ??
      (retained?.turnId === chatTurnId ? retained.lifecycle : null);
    if (lifecycle !== null) {
      this.#priorQuotaTerminals.delete(paneId);
      await this.#observeHarnessTerminal(
        paneId,
        chatTurnId,
        lifecycle,
      );
      return;
    }
    await this.#settleHarnessBeforeProvider(
      paneId,
      chatTurnId,
      "provider_unavailable",
    );
  }

  async #publishNoAccountAttention(
    pane: ChatPanePrivateRecord,
    candidates: readonly ChatAccountCandidate[],
    turnId: ChatTurnId,
  ): Promise<void> {
    if (candidates.length === 0) {
      await this.#publishAttention(pane.projection.id, turnId, {
        code: "account_required",
        message: "Connect a Codex subscription in Settings, then send another message.",
        retryable: true,
      }, false);
      return;
    }
    const allCapacityBound = candidates.every(
      ({ budget }) => budget === "low" || budget === "exhausted",
    );
    await this.#publishAttention(pane.projection.id, turnId, allCapacityBound
      ? {
          code: "all_accounts_exhausted",
          message: "Every connected Codex account is unavailable or near its usage limit. You can send another message later.",
          retryable: true,
        }
      : {
          code: "account_unavailable",
          message: "No connected Codex account has a fresh, safe usage budget. Try again.",
          retryable: true,
        }, false);
  }

  async #publishProviderFailure(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
    error: unknown,
    fallbackCode: "turn_failed" | "continuation_failed",
  ): Promise<void> {
    if (fallbackCode === "continuation_failed") {
      await this.#publishContextReset(paneId, turnId);
      return;
    }
    const ambiguous = !(error instanceof ChatProviderEffectError) || error.certainty === "ambiguous";
    const configuration = error instanceof ChatProviderEffectError && error.code === "configuration";
    const authentication = error instanceof ChatProviderEffectError && error.code === "authentication";
    await this.#publishAttention(paneId, turnId, {
      code: configuration || authentication ? "account_unavailable" : fallbackCode,
      message: ambiguous
        ? "The provider outcome is uncertain, so HRA did not replay it. You can send another message."
        : "The turn could not start. You can send another message.",
      retryable: true,
    }, ambiguous);
  }

  async #publishContextReset(paneId: ChatPaneId, turnId: ChatTurnId): Promise<void> {
    this.#attachedHarnessProjectionFences.delete(paneId);
    this.#discardEarlySessionEvents(paneId);
    this.#quotaProofFloors.delete(paneId);
    this.#priorQuotaTerminals.delete(paneId);
    const pane = this.#store.resetContextWithAttention({
      paneId,
      turnId,
      attention: {
        code: "continuation_failed",
        message: "Earlier context could not be transferred safely, so HRA cleared it. Send your message again to start fresh.",
        retryable: true,
      },
      now: this.#now(),
    });
    if (pane !== null) await this.#projection.paneStateChanged(pane);
  }

  async #publishAttention(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
    attention: Parameters<ChatPaneStore["enterAttention"]>[0]["attention"],
    clearBinding: boolean,
  ): Promise<void> {
    const pane = this.#store.enterAttention({
      paneId,
      turnId,
      attention,
      clearBinding,
      now: this.#now(),
    });
    this.#attachedHarnessProjectionFences.delete(paneId);
    this.#clearAttachedHarnessStartupRetry(paneId, turnId);
    this.#discardEarlySessionEvents(paneId);
    this.#quotaProofFloors.delete(paneId);
    this.#priorQuotaTerminals.delete(paneId);
    if (pane !== null) await this.#projection.paneStateChanged(pane);
  }

  #rememberQuotaFloor(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
    accountProfileId: ChatAccountProfileId,
    cursor: ChatQuotaProofCursor | undefined,
  ): void {
    if (cursor === undefined) {
      this.#quotaProofFloors.delete(paneId);
      return;
    }
    if (
      !Number.isSafeInteger(cursor.generation) || cursor.generation < 1 ||
      !Number.isSafeInteger(cursor.streamPosition) || cursor.streamPosition < 0
    ) {
      throw new ChatProviderEffectError({ certainty: "ambiguous", code: "runtime" });
    }
    this.#quotaProofFloors.set(paneId, { turnId, accountProfileId, cursor });
  }

  #bestEffortName(binding: ChatThreadBinding, title: string): void {
    try {
      void this.#provider.setThreadName(binding, title).catch(() => undefined);
    } catch {
      // Pane titles are HRA-owned and remain authoritative.
    }
  }

  #rememberSessionItemEvent(
    paneId: ChatPaneId,
    effect: Extract<SessionEffect, {
      readonly type: "tool_item_started" | "reasoning_item_completed";
    }>,
  ): boolean {
    let observed = this.#observedSessionItemEvents.get(paneId);
    if (observed === undefined) {
      observed = new Set<string>();
      this.#observedSessionItemEvents.set(paneId, observed);
    }
    const key = `${effect.type}:${effect.itemId}`;
    if (observed.has(key)) return false;
    if (observed.size >= MAX_EXACT_SESSION_ITEMS_PER_TURN) {
      throw new ChatPaneStoreError("limit", "This chat turn produced too many exact item events.");
    }
    observed.add(key);
    return true;
  }

  async #tryName(binding: ChatThreadBinding, title: string): Promise<void> {
    try {
      await this.#provider.setThreadName(binding, title);
    } catch {
      // The HRA pane title remains authoritative and the critical turn may proceed.
    }
  }

  #beginAttachedHarnessStartupRecovery(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
    reconcileFirst: boolean,
    delayFirst = false,
  ): void {
    if (this.#admissionClosed) return;
    const current = this.#attachedHarnessStartupRetries.get(paneId);
    if (current?.turnId === turnId) return;
    this.#clearAttachedHarnessStartupRetry(paneId);
    if (!this.#isExactActiveAttachedHarnessTurn(paneId, turnId)) return;
    const retry: AttachedHarnessStartupRetry = {
      paneId,
      turnId,
      inFlight: false,
      retryStage: 0,
      timer: null,
    };
    this.#attachedHarnessStartupRetries.set(paneId, retry);
    if (delayFirst) {
      this.#scheduleAttachedHarnessStartupRetry(retry);
    } else {
      this.#runAttachedHarnessStartupAttempt(retry, reconcileFirst);
    }
  }

  #runAttachedHarnessStartupAttempt(
    retry: AttachedHarnessStartupRetry,
    reconcile: boolean,
  ): void {
    if (
      this.#admissionClosed || retry.inFlight || retry.timer !== null ||
      this.#attachedHarnessStartupRetries.get(retry.paneId) !== retry
    ) return;
    if (!this.#isExactActiveAttachedHarnessTurn(retry.paneId, retry.turnId)) {
      this.#clearAttachedHarnessStartupRetry(retry.paneId, retry.turnId);
      return;
    }
    retry.inFlight = true;
    void this.#serialize(retry.paneId, async () => {
      if (
        this.#admissionClosed ||
        this.#attachedHarnessStartupRetries.get(retry.paneId) !== retry ||
        !this.#isExactActiveAttachedHarnessTurn(retry.paneId, retry.turnId)
      ) {
        return "stale" as const;
      }
      try {
        return await this.#startAttachedHarnessTurn(
          retry.paneId,
          retry.turnId,
          reconcile,
        );
      } catch {
        // An exception cannot prove whether actor admission was applied. Every
        // later attempt reconciles the same durable logical turn.
        return "recovering" as const;
      }
    }).then(
      (result) => this.#finishAttachedHarnessStartupAttempt(retry, result),
      () => this.#finishAttachedHarnessStartupAttempt(retry, "recovering"),
    );
  }

  #finishAttachedHarnessStartupAttempt(
    retry: AttachedHarnessStartupRetry,
    result: AttachedHarnessAttemptResult,
  ): void {
    if (this.#attachedHarnessStartupRetries.get(retry.paneId) !== retry) return;
    retry.inFlight = false;
    if (
      this.#admissionClosed || result !== "recovering" ||
      !this.#isExactActiveAttachedHarnessTurn(retry.paneId, retry.turnId)
    ) {
      this.#clearAttachedHarnessStartupRetry(retry.paneId, retry.turnId);
      return;
    }
    this.#scheduleAttachedHarnessStartupRetry(retry);
  }

  #scheduleAttachedHarnessStartupRetry(retry: AttachedHarnessStartupRetry): void {
    if (
      this.#admissionClosed || retry.inFlight || retry.timer !== null ||
      this.#attachedHarnessStartupRetries.get(retry.paneId) !== retry
    ) return;
    retry.retryStage = Math.min(
      retry.retryStage + 1,
      MAX_ATTACHED_HARNESS_RETRY_STAGE,
    );
    let delayMs: number;
    try {
      delayMs = this.#attachedHarnessRetryDelayMs(retry.retryStage);
    } catch {
      delayMs = attachedHarnessRetryDelay(retry.retryStage);
    }
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
      delayMs = attachedHarnessRetryDelay(retry.retryStage);
    }
    delayMs = Math.min(delayMs, MAX_ATTACHED_HARNESS_RETRY_MILLISECONDS);
    retry.timer = setTimeout(() => {
      if (this.#attachedHarnessStartupRetries.get(retry.paneId) !== retry) return;
      retry.timer = null;
      if (this.#admissionClosed) {
        this.#clearAttachedHarnessStartupRetry(retry.paneId, retry.turnId);
        return;
      }
      this.#runAttachedHarnessStartupAttempt(retry, true);
    }, delayMs);
  }

  #clearAttachedHarnessStartupRetry(
    paneId: ChatPaneId,
    turnId?: ChatTurnId,
  ): void {
    const retry = this.#attachedHarnessStartupRetries.get(paneId);
    if (retry === undefined || (turnId !== undefined && retry.turnId !== turnId)) return;
    if (retry.timer !== null) clearTimeout(retry.timer);
    this.#attachedHarnessStartupRetries.delete(paneId);
  }

  #isExactActiveAttachedHarnessTurn(paneId: ChatPaneId, turnId: ChatTurnId): boolean {
    try {
      const pane = this.#store.get(paneId);
      return pane !== null &&
        pane.projection.interactionMode === "harnessObserver" &&
        pane.projection.turn?.id === turnId &&
        pane.activePrompt !== null &&
        activePane(pane.projection);
    } catch {
      return false;
    }
  }

  #scheduleWorkspaceProvision(
    paneId: ChatPaneId,
    selectedRepository?: ChatRepository,
  ): void {
    void this.#serialize(paneId, async () => {
      const current = this.#store.get(paneId);
      if (current === null) return;
      const before = current.projection;
      const beforeWorkspace = before.workspace;
      if (
        before.interactionMode !== "chat" || beforeWorkspace === null ||
        beforeWorkspace.mode !== "managedWorktree" ||
        beforeWorkspace.state === "preserved"
      ) return;
      this.#cancelWorkspaceResolutionRetryTimer(paneId);
      let repository: ChatRepository | null = selectedRepository ?? null;
      if (repository === null) {
        try {
          repository = await this.#repositories.resolve(before.repository.id);
        } catch {
          repository = null;
        }
      }
      if (repository === null || repository.id !== before.repository.id) {
        const projected = this.#workspaces.markRepositoryUnavailable(paneId);
        this.#scheduleWorkspaceResolutionRetry(paneId);
        if (
          projected.revision !== before.revision ||
          projected.workspace?.revision !== beforeWorkspace.revision
        ) await this.#projection.paneChanged(projected);
        return;
      }
      const beforeWorkspaceRevision = beforeWorkspace.revision;
      const projected = await this.#workspaces.provision(paneId, repository);
      if (projected.workspace?.state === "waitingCapacity") {
        this.#scheduleWorkspaceResolutionRetry(paneId);
      } else {
        this.#clearWorkspaceResolutionRetry(paneId);
      }
      if (
        projected.revision !== before.revision ||
        projected.workspace?.revision !== beforeWorkspaceRevision
      ) await this.#projection.paneChanged(projected);
    }).catch(() => undefined);
  }

  #scheduleWorkspaceResolutionRetry(paneId: ChatPaneId): void {
    if (
      this.#admissionClosed ||
      this.#workspaceResolutionRetryTimers.has(paneId)
    ) return;
    const attempt = Math.min(
      (this.#workspaceResolutionRetryAttempts.get(paneId) ?? 0) + 1,
      Number.MAX_SAFE_INTEGER,
    );
    this.#workspaceResolutionRetryAttempts.set(paneId, attempt);
    let delayMs: number;
    try {
      delayMs = this.#workspaceRetryDelayMs(attempt);
    } catch {
      delayMs = workspaceResolutionRetryDelay(attempt);
    }
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
      delayMs = workspaceResolutionRetryDelay(attempt);
    }
    delayMs = Math.min(delayMs, MAX_WORKSPACE_RESOLUTION_RETRY_MILLISECONDS);
    const timer = setTimeout(() => {
      this.#workspaceResolutionRetryTimers.delete(paneId);
      if (this.#admissionClosed) return;
      this.#scheduleWorkspaceProvision(paneId);
    }, delayMs);
    this.#workspaceResolutionRetryTimers.set(paneId, timer);
  }

  #clearWorkspaceResolutionRetry(paneId: ChatPaneId): void {
    this.#cancelWorkspaceResolutionRetryTimer(paneId);
    this.#workspaceResolutionRetryAttempts.delete(paneId);
  }

  #cancelWorkspaceResolutionRetryTimer(paneId: ChatPaneId): void {
    const timer = this.#workspaceResolutionRetryTimers.get(paneId);
    if (timer !== undefined) clearTimeout(timer);
    this.#workspaceResolutionRetryTimers.delete(paneId);
  }

  #serialize<T>(paneId: ChatPaneId, operation: () => T | Promise<T>): Promise<T> {
    const id = chatPaneIdSchema.parse(paneId);
    const prior = this.#paneTails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const marker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.catch(() => undefined).then(() => marker);
    this.#paneTails.set(id, tail);
    return prior
      .catch(() => undefined)
      .then(operation)
      .finally(() => {
        release();
        if (this.#paneTails.get(id) === tail) this.#paneTails.delete(id);
      });
  }
}

function attachedHarnessRetryDelay(attempt: number): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 16);
  return Math.min(
    MAX_ATTACHED_HARNESS_RETRY_MILLISECONDS,
    250 * 2 ** exponent,
  );
}

function workspaceResolutionRetryDelay(attempt: number): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 16);
  return Math.min(
    MAX_WORKSPACE_RESOLUTION_RETRY_MILLISECONDS,
    500 * 2 ** exponent,
  );
}

export function rankChatAccountCandidates(
  candidates: readonly ChatAccountCandidate[],
  preferredAccountProfileId: ChatAccountProfileId | null,
  visitedAccountProfileIds: readonly ChatAccountProfileId[],
): readonly ChatAccountCandidate[] {
  const visited = new Set(visitedAccountProfileIds.map((value) => accountProfileIdSchema.parse(value)));
  const unique = new Map<ChatAccountProfileId, ChatAccountCandidate>();
  for (const candidate of candidates) {
    const id = accountProfileIdSchema.parse(candidate.id);
    if (unique.has(id)) throw new Error("Chat account routing returned a duplicate account.");
    // Usage telemetry is an optimization, not an admission authority. A
    // transiently unknown or low-but-positive budget must not block coding
    // when no healthy subscription is available. Only an explicit exhaustion
    // proof, or a subscription already attempted in this failover chain, is a
    // closed exclusion.
    if (candidate.budget !== "exhausted" && !visited.has(id)) {
      unique.set(id, { ...candidate, id });
    }
  }
  return [...unique.values()].toSorted((left, right) => {
    const budgetDifference = chatAccountBudgetRank(left.budget) -
      chatAccountBudgetRank(right.budget);
    if (budgetDifference !== 0) return budgetDifference;
    const leftPreferred = left.id === preferredAccountProfileId;
    const rightPreferred = right.id === preferredAccountProfileId;
    if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
    if (left.selected !== right.selected) return left.selected ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
}

function chatAccountBudgetRank(budget: ChatAccountCandidate["budget"]): number {
  switch (budget) {
    case "healthy": return 0;
    case "unknown": return 1;
    case "low": return 2;
    case "exhausted": return 3;
  }
}

function configurationFor(pane: ChatPanePrivateRecord): ChatProviderConfiguration {
  return {
    ...providerConfiguration,
    reasoningEffort: pane.projection.reasoningEffort,
    serviceTier: pane.projection.serviceTier,
  };
}

function provenQuotaRejection(error: unknown): boolean {
  return error instanceof ChatProviderEffectError &&
    error.certainty === "not_applied" &&
    error.code === "quota_reached" &&
    error.quotaProof === "provider_rate_limit_reached";
}

function ambiguousProviderEffect(error: unknown): boolean {
  return !(error instanceof ChatProviderEffectError) || error.certainty === "ambiguous";
}

function activePane(pane: ChatPaneProjection): boolean {
  return pane.state === "starting" || pane.state === "streaming" || pane.state === "continuing";
}

function sessionEventKey(input: Readonly<{
  readonly accountProfileId: string;
  readonly providerThreadId: string;
  readonly providerTurnId: string;
}>): string {
  return JSON.stringify([
    input.accountProfileId,
    input.providerThreadId,
    input.providerTurnId,
  ]);
}

function sameSessionEvent(left: SessionEventEnvelope, right: SessionEventEnvelope): boolean {
  return left.accountProfileId === right.accountProfileId &&
    left.providerThreadId === right.providerThreadId &&
    left.providerTurnId === right.providerTurnId;
}

function containmentTarget(pane: ChatPanePrivateRecord): TurnContainmentTarget {
  const turnId = pane.projection.turn?.id;
  if (turnId === undefined) {
    throw new ChatPaneStoreError("invalid_state", "The chat pane has no active turn.");
  }
  return {
    paneId: pane.projection.id,
    turnId,
    binding: pane.binding,
    providerTurnId: pane.providerTurnId,
  };
}

function reservedContainmentAccount(
  pane: ChatPanePrivateRecord,
  target: TurnContainmentTarget,
): ChatAccountProfileId | null {
  // `reserveAccount` appends before validate/start/resume/turn RPCs. The last
  // visited identity is therefore the exact generation that owns any current
  // pre-binding ambiguity. A binding is authoritative only once an accepted
  // provider turn exists; otherwise it may belong to a prior logical turn.
  return pane.visitedAccountProfileIds.at(-1) ??
    (target.providerTurnId === null ? null : target.binding?.accountProfileId ?? null);
}

function validateInterruptTerminalGrace(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 60_000) {
    throw new RangeError("Interrupt terminal grace must be an integer from 0 through 60000 ms.");
  }
  return value;
}

function validateHarnessRootTransitionTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new RangeError(
      "Harness root transition timeout must be an integer from 1 through 60000 ms.",
    );
  }
  return value;
}

function validateInterruptAckTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new RangeError(
      "Interrupt acknowledgement timeout must be an integer from 1 through 60000 ms.",
    );
  }
  return value;
}

function validateAccountContainmentTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new RangeError(
      "Account containment timeout must be an integer from 1 through 60000 ms.",
    );
  }
  return value;
}

function validateHarnessActorTransitionTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new RangeError(
      "Harness actor transition timeout must be an integer from 1 through 60000 ms.",
    );
  }
  return value;
}

function deltaBatchBytes(
  effect: Extract<SessionEffect, { type: "delta_batch" }>,
): number {
  return effect.deltas.reduce((total, delta) => total + utf8ByteLength(delta), 0);
}

function sessionEffectBytes(effect: SessionEffect): number {
  switch (effect.type) {
    case "delta_batch":
      return deltaBatchBytes(effect);
    case "assistant_completed":
      return utf8ByteLength(effect.fullText);
    case "protocol_failure":
    case "reasoning_item_completed":
    case "terminal":
    case "tool_completed":
    case "tool_started":
    case "tool_item_started":
    case "unexpected_interaction":
      return 0;
  }
}

function coalescedStoreDeltas(deltas: readonly string[]): readonly string[] {
  const packed: string[] = [];
  let pending = "";
  let pendingBytes = 0;
  for (const delta of deltas) {
    const deltaBytes = utf8ByteLength(delta);
    if (pendingBytes + deltaBytes <= CHAT_MAX_DELTA_UTF8_BYTES) {
      pending += delta;
      pendingBytes += deltaBytes;
      continue;
    }
    if (pending.length > 0) packed.push(pending);
    pending = delta;
    pendingBytes = deltaBytes;
  }
  if (pending.length > 0) packed.push(pending);
  return Object.freeze(packed);
}

/** Appends at only the 4 KiB boundary instead of rebuilding a growing stream. */
function appendCoalescedStoreDeltas(
  existing: readonly string[],
  incoming: readonly string[],
): readonly string[] {
  if (existing.length === 0) return coalescedStoreDeltas(incoming);
  const packed = [...existing];
  for (const delta of incoming) {
    const last = packed.pop();
    if (last === undefined) {
      packed.push(...coalescedStoreDeltas([delta]));
      continue;
    }
    packed.push(...utf8Chunks(`${last}${delta}`, CHAT_MAX_DELTA_UTF8_BYTES));
  }
  return Object.freeze(packed);
}
