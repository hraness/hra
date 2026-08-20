import { randomBytes } from "node:crypto";
import {
  canonicalScheduledChatRRuleSchema,
  nextScheduledChatOccurrence,
  positiveSyncUint64Schema,
  scheduledChatTimeZoneSchema,
  syncSha256DigestSchema,
} from "@hraness/agent-tasks-protocol";
import {
  accountProfileIdSchema,
  chatPaneIdSchema,
  chatTurnIdSchema,
  type ChatMessageId,
  type ChatMessageQueueProjection,
  type ChatRootTurnProfile,
} from "../../../contracts/runtime";
import type { RootTurnRoutingAuthorityV1 } from "../harness/root-turn-routing-sqlite-v1";
import type {
  ChatAttachmentProviderDescriptor,
  ChatAttachmentVault,
} from "../attachments/contracts";
import { ChatPaneStoreError } from "../state/chat-pane-store";
import type { ScheduledChatStore } from "../state/scheduled-chat-store";
import type {
  ChatMessageClaim,
} from "../state/chat-message-ledger";
import type {
  ChatProviderThreadArchiveFinalizationV57Result,
  ChatProviderThreadArchiveIntent,
  ChatProviderThreadArchiveReconciliationV57,
  ChatProviderThreadArchiveTerminalComponentV57,
  ChatPaneDeltaBatchInput,
  ChatPaneDeltaBatchResult,
  ChatPaneStore,
} from "../state/chat-pane-store";
import type {
  ProviderThreadArchiveCutSnapshotV57,
  ProviderThreadArchiveRecoveryInventoryV57,
  ProviderThreadArchiveTargetSnapshotV57,
} from "../state/provider-thread-archive-journal-v57";
import type {
  SessionAssistantItemCompletion,
  SessionInteractionRequest,
  SessionReasoningItemCompletion,
  SessionProviderSubagents,
  SessionToolItemStarted,
  SessionTurnActivity,
  SessionTurnLifecycle,
} from "../sessions/session-service";
import { utf8ByteLength, utf8Chunks } from "./text-bounds";
import {
  CHAT_MAX_DELTA_UTF8_BYTES,
  CHAT_MAX_PANES,
  CHAT_MAX_ASSISTANT_RECONCILIATION_UTF8_BYTES,
  CHAT_MAX_RESPONSE_TAIL_UTF8_BYTES,
  ChatProviderEffectError,
  chatProviderAttachmentAuthority,
  type ChatAccountCandidate,
  type ChatArchiveRecoveryDescriptor,
  type ChatArchiveTransitionHandleV57,
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
  type ChatProviderInput,
  type ChatProviderResolvedConfiguration,
  type ChatProviderPort,
  type ChatRepository,
  type ChatRepositoryPort,
  type ChatRuntimeRecoveryPort,
  type ChatScheduledChatPort,
  type ChatScheduledOccurrence,
  type ChatAccountPort,
  type ChatThreadBinding,
  type ChatToolActivity,
  type ChatTurnId,
  type ChatTurnTerminal,
  type ChatUnexpectedInteraction,
  type ChatPaneProjection,
  type ChatWorkspacePort,
} from "./types";

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
const MAX_SCHEDULED_ATTENTION_RETRY_MILLISECONDS = 5 * 60_000;
// Tests retain an explicit false override for deterministic rollback coverage.
const PROVIDER_THREAD_ARCHIVE_COORDINATOR_V57_ENABLED = true;

type SessionEffect =
  | Readonly<{
      readonly type: "delta_batch";
      readonly channel: "reasoningSummary" | "responseMarkdown";
      readonly deltas: readonly string[];
      readonly assistantMessageId?: string;
      readonly reasoningItemId?: string;
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
      readonly reasoningReceipt?: SessionReasoningItemCompletion["receipt"];
    }>
  | Readonly<{
      readonly type: "provider_subagents";
      readonly projection: SessionProviderSubagents["projection"];
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

interface EarlyUnexpectedInteractionLatch {
  readonly paneId: ChatPaneId;
  readonly logicalTurnId: ChatTurnId;
  readonly accountProfileId: ChatAccountProfileId;
  readonly providerThreadId: string;
  readonly providerTurnId: string;
  conflicted: boolean;
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

interface ActiveStartMessageEffect {
  readonly content: ChatMessageClaim["content"];
  readonly messageId: ChatMessageClaim["messageId"];
  readonly paneId: ChatPaneId;
  readonly turnId: ChatTurnId;
  revision: number;
  state: "claimed" | "effectStarted" | "acknowledged" | "ambiguous";
}

interface ProviderAttachmentEffect {
  readonly bindingId: string;
  readonly bindingKeyDigest: string;
  readonly paneId: ChatPaneId;
  readonly revision: number;
}

interface PreparedProviderAttachmentInput {
  readonly input: readonly ChatProviderInput[];
  readonly lease: ProviderAttachmentEffect | null;
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

interface ProviderThreadArchiveHold {
  readonly authorityHandle: string;
  readonly descriptor: ChatArchiveRecoveryDescriptor;
}

interface ProviderThreadArchiveLiveCommand {
  readonly accountProfileId: ChatAccountProfileId;
  readonly binding: ChatThreadBinding;
  readonly expectedQueueRevision: number | null;
  readonly expectedRevision: number;
  readonly paneId: ChatPaneId;
  readonly purpose: "pane_archive" | "start_fresh";
}

interface ProviderThreadArchiveReservedPane {
  drained: boolean;
  readonly paneId: ChatPaneId;
  readonly prior: Promise<void>;
  readonly release: () => void;
  readonly tail: Promise<void>;
}

interface ScheduledChatCoordinatorPaneReservation {
  readonly callbacks: Set<Promise<void>>;
  readonly paneId: ChatPaneId;
  readonly prior: Promise<void>;
  readonly release: () => void;
  readonly tail: Promise<void>;
}

interface ProviderThreadArchiveFinalizedTarget {
  readonly result: ChatProviderThreadArchiveFinalizationV57Result;
  readonly targetId: string;
}

interface ProviderThreadArchiveDirectResponse {
  readonly containmentReceipt: string;
  readonly generation: number;
  readonly streamPosition: number;
}

interface ProviderThreadArchiveRecoveryEffects {
  readonly containedPaneIds: Set<ChatPaneId>;
  readonly finalized: ProviderThreadArchiveFinalizedTarget[];
  readonly paneReservations:
    Map<ChatPaneId, ProviderThreadArchiveReservedPane>;
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
  readonly attachments?: ChatAttachmentVault;
  readonly harnessActors?: ChatHarnessActorTurnPort;
  readonly harnessRoots?: ChatHarnessRootPort;
  readonly now?: () => Date;
  readonly projection: ChatProjectionSink;
  readonly projectPane?: (pane: ChatPaneProjection) => ChatPaneProjection;
  /** Internal proof seam; production remains fail-closed until v57 gates pass. */
  readonly providerThreadArchiveCoordinatorV57Enabled?: boolean;
  readonly provider: ChatProviderPort;
  readonly scheduledChats?: ChatScheduledChatPort;
  readonly scheduledChatStore?: ScheduledChatStore;
  readonly repositories: ChatRepositoryPort;
  readonly runtimeRecovery: ChatRuntimeRecoveryPort;
  readonly rootTurnRouting: RootTurnRoutingAuthorityV1;
  readonly store: ChatPaneStore;
  readonly workspaces: ChatWorkspacePort;
  readonly attachedHarnessRetryDelayMs?: (attempt: number) => number;
  readonly workspaceRetryDelayMs?: (attempt: number) => number;
  readonly scheduledAttentionRetryDelayMs?: (attempt: number) => number;
  readonly interruptTerminalGraceMs?: number;
  readonly interruptAckTimeoutMs?: number;
  readonly harnessRootTransitionTimeoutMs?: number;
  readonly accountContainmentTimeoutMs?: number;
  readonly harnessActorTransitionTimeoutMs?: number;
}

export class ChatService {
  readonly #accounts: ChatAccountPort;
  readonly #attachments: ChatAttachmentVault | null;
  readonly #harnessActors: ChatHarnessActorTurnPort | null;
  readonly #harnessRoots: ChatHarnessRootPort | null;
  readonly #now: () => Date;
  readonly #projection: ChatProjectionSink;
  readonly #projectPane: (pane: ChatPaneProjection) => ChatPaneProjection;
  readonly #providerThreadArchiveCoordinatorV57Enabled: boolean;
  readonly #provider: ChatProviderPort;
  readonly #scheduledChats: ChatScheduledChatPort | null;
  readonly #scheduledChatStore: ScheduledChatStore | null;
  readonly #repositories: ChatRepositoryPort;
  readonly #runtimeRecovery: ChatRuntimeRecoveryPort;
  readonly #rootTurnRouting: RootTurnRoutingAuthorityV1;
  readonly #store: ChatPaneStore;
  readonly #workspaces: ChatWorkspacePort;
  readonly #attachedHarnessRetryDelayMs: (attempt: number) => number;
  readonly #workspaceRetryDelayMs: (attempt: number) => number;
  readonly #scheduledAttentionRetryDelayMs: (attempt: number) => number;
  readonly #interruptTerminalGraceMs: number;
  readonly #interruptAckTimeoutMs: number;
  readonly #harnessRootTransitionTimeoutMs: number;
  readonly #accountContainmentTimeoutMs: number;
  readonly #harnessActorTransitionTimeoutMs: number;
  readonly #accountArchiveTails =
    new Map<ChatAccountProfileId, Promise<void>>();
  readonly #paneTails = new Map<ChatPaneId, Promise<void>>();
  readonly #scheduledChatCoordinatorReservations =
    new Map<ChatPaneId, ScheduledChatCoordinatorPaneReservation>();
  readonly #providerEffects = new Set<Promise<void>>();
  readonly #providerThreadArchiveHolds =
    new Map<ChatPaneId, ProviderThreadArchiveHold>();
  readonly #sessionProjectionQueues = new Map<ChatPaneId, SessionProjectionQueue>();
  readonly #pendingStreamPersistence: PendingStreamPersistence[] = [];
  readonly #pendingTurnStops = new Map<ChatPaneId, PendingTurnStop>();
  readonly #pendingTurnContainments = new Map<ChatPaneId, PendingTurnContainment>();
  readonly #activeStartMessageEffects = new Map<ChatPaneId, ActiveStartMessageEffect>();
  readonly #exactProviderTerminalReceipts =
    new Map<ChatPaneId, ExactProviderTerminalReceipt>();
  readonly #exactProviderTerminalWaiters = new Map<ChatPaneId, ExactProviderTerminalWaiter>();
  readonly #earlySessionEvents = new Map<ChatPaneId, PaneEarlySessionEvents>();
  readonly #earlyUnexpectedInteractions =
    new Map<ChatPaneId, EarlyUnexpectedInteractionLatch>();
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
  readonly #scheduledAttentionRetries = new Map<ChatPaneId, Readonly<{
    attempt: number;
    notBefore: number;
  }>>();
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
    this.#attachments = options.attachments ?? null;
    this.#harnessActors = options.harnessActors ?? null;
    this.#harnessRoots = options.harnessRoots ?? null;
    this.#now = options.now ?? (() => new Date());
    this.#projection = options.projection;
    this.#projectPane = options.projectPane ?? ((pane) => pane);
    this.#providerThreadArchiveCoordinatorV57Enabled =
      options.providerThreadArchiveCoordinatorV57Enabled ??
        PROVIDER_THREAD_ARCHIVE_COORDINATOR_V57_ENABLED;
    this.#provider = options.provider;
    this.#scheduledChats = options.scheduledChats ?? null;
    this.#scheduledChatStore = options.scheduledChatStore ?? null;
    this.#repositories = options.repositories;
    this.#runtimeRecovery = options.runtimeRecovery;
    this.#rootTurnRouting = options.rootTurnRouting;
    this.#store = options.store;
    this.#workspaces = options.workspaces;
    this.#attachedHarnessRetryDelayMs = options.attachedHarnessRetryDelayMs ??
      attachedHarnessRetryDelay;
    this.#workspaceRetryDelayMs = options.workspaceRetryDelayMs ??
      workspaceResolutionRetryDelay;
    this.#scheduledAttentionRetryDelayMs =
      options.scheduledAttentionRetryDelayMs
      ?? ((attempt) => Math.min(
        5_000 * (2 ** Math.min(attempt, 6)),
        MAX_SCHEDULED_ATTENTION_RETRY_MILLISECONDS,
      ));
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
    this.installProviderThreadArchiveQuarantines();
    this.assertProviderThreadArchiveQuarantinesInstalled();
  }

  /**
   * Replays every durable v56 admission hold synchronously. Construction does
   * this before AccountService startup can launch or refresh a provider; the
   * explicit method is retained as a boot assertion seam.
   */
  installProviderThreadArchiveQuarantines(): void {
    for (const paneId of this.#store.pendingProviderThreadArchivePaneIds()) {
      const intent = this.#store.providerThreadArchiveIntent(paneId);
      if (intent === null || intent.state === "account_contained") {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "The provider archive hold inventory changed during startup.",
        );
      }
      this.#retainProviderThreadArchiveHold(intent);
    }
  }

  assertProviderThreadArchiveQuarantinesInstalled(): void {
    const pending = this.#store.pendingProviderThreadArchivePaneIds();
    if (pending.length !== this.#providerThreadArchiveHolds.size) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "Provider archive holds were not installed before account startup.",
      );
    }
    for (const paneId of pending) {
      const intent = this.#store.providerThreadArchiveIntent(paneId);
      const installed = this.#providerThreadArchiveHolds.get(paneId);
      if (
        intent === null ||
        installed === undefined ||
        !sameArchiveDescriptor(
          installed.descriptor,
          providerThreadArchiveDescriptor(intent),
        )
      ) {
        throw new ChatPaneStoreError(
          "corrupt_state",
          "Provider archive hold replay does not match durable v56 state.",
        );
      }
    }
    if (pending.length > 0) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Pending provider thread archives are quarantined before account startup until exact recovery is complete.",
      );
    }
  }

  initialize(): readonly ChatPaneProjection[] {
    this.assertProviderThreadArchiveQuarantinesInstalled();
    const pendingTransitionPaneIds = Object.freeze([
      ...new Set([
        ...this.#store.pendingProviderThreadArchivePaneIds(),
        ...this.#store.providerThreadArchiveRecoveryPaneIdsV57(),
        ...(this.#scheduledChatStore?.pendingMutations().map(
          (mutation) => mutation.paneId,
        ) ?? []),
        ...(this.#scheduledChatStore?.desiredOffIntents().map(
          (intent) => intent.paneId,
        ) ?? []),
      ]),
    ].sort());
    const pendingTransitionPanes = new Set(pendingTransitionPaneIds);
    const scheduledStartupDrainPanes = new Set<ChatPaneId>();
    this.#store.clearVolatileProviderSubagents(
      this.#now(),
      pendingTransitionPaneIds,
    );
    this.#store.recoverInterrupted(this.#now(), {
      preserveAttachedHarness: this.#harnessActors !== null,
      excludePaneIds: pendingTransitionPaneIds,
    });
    for (const pane of this.#store.list()) {
      if (pendingTransitionPanes.has(pane.id)) continue;
      if (pane.interactionMode !== "chat") continue;
      if (pane.turn !== null && !activePane(pane)) {
        this.#store.completeAcknowledgedMessagesForTurn(
          pane.id,
          pane.turn.id,
          this.#now(),
        );
      }
      let queue = this.#store.reconcileMessageQueueAfterRestart(
        pane.id,
        this.#now(),
      );
      const schedule = this.#scheduledChatStore?.get(pane.id) ?? null;
      const head = queue.messages[0];
      const run = head === undefined
        ? null
        : this.#scheduledChatStore?.runForMessage(pane.id, head.id) ?? null;
      if (
        queue.pauseReason === "runtimeRestart"
        && schedule !== null
        && this.#scheduledChatStore?.mutationForPane(pane.id) === null
        && run !== null
        && run.sessionId === schedule.sessionId
        && run.scheduleGeneration === schedule.generation
        && run.cancelledAt === null
      ) {
        queue = this.#store.resumeMessageQueue({
          paneId: pane.id,
          expectedQueueRevision: queue.revision,
          now: this.#now(),
        });
        scheduledStartupDrainPanes.add(pane.id);
      }
    }
    const panes = this.#store.list();
    for (const pane of panes) {
      if (pendingTransitionPanes.has(pane.id)) continue;
      if (
        pane.interactionMode === "chat" && pane.workspace !== null &&
        pane.workspace.mode === "managedWorktree" &&
        pane.workspace.state !== "preserved"
      ) this.#scheduleWorkspaceProvision(pane.id);
    }
    if (this.#harnessActors !== null) {
      for (const pane of panes) {
        if (pendingTransitionPanes.has(pane.id)) continue;
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
    if (this.#providerThreadArchiveCoordinatorV57Enabled) {
      this.#scheduleProviderThreadArchiveRecoveryV57(
        this.#store.verifyProviderThreadArchiveRecoveryV57(),
      );
    }
    for (const paneId of scheduledStartupDrainPanes) {
      void this.#serialize(paneId, async () => {
        await this.#admitNextQueuedMessage(paneId);
      }).catch(() => undefined);
    }
    return panes.map((pane) => this.#projectPane(pane));
  }

  list(): readonly ChatPaneProjection[] {
    return this.#store.list().map((pane) => this.#projectPane(pane));
  }

  async handleAccountUnavailable(
    accountProfileId: ChatAccountProfileId,
    options: Readonly<{
      readonly expectedGeneration?: number;
    }> = {},
  ): Promise<void> {
    await this.#handleAccountUnavailable(
      accountProfileId,
      options,
      "genericGenerationLoss",
    );
  }

  async handleAccountRemoval(
    accountProfileId: ChatAccountProfileId,
  ): Promise<void> {
    await this.#handleAccountUnavailable(
      accountProfileId,
      {},
      "explicitAccountRemoval",
    );
  }

  /**
   * Closed callback registered with AccountService for one approved archive
   * fence. Account admission is quarantined for the entire call. Sibling
   * detachment is durable before the initiating v56 intent is marked
   * generation-contained, so that bit is the final join rather than an
   * optimistic promise.
   */
  async joinProviderThreadArchiveGenerationContainment(
    input: ChatArchiveRecoveryDescriptor & Readonly<{ authorityHandle: string }>,
  ): Promise<void> {
    const paneId = chatPaneIdSchema.parse(input.paneId);
    const accountId = accountProfileIdSchema.parse(input.accountProfileId);
    if (
      !Number.isSafeInteger(input.expectedGeneration) ||
      input.expectedGeneration < 1
    ) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The provider archive containment generation is invalid.",
      );
    }
    const requireUncontainedIntent = (): ChatProviderThreadArchiveIntent => {
      const intent = this.#store.providerThreadArchiveIntent(paneId);
      const installed = this.#providerThreadArchiveHolds.get(paneId);
      if (
        intent === null ||
        intent.state !== "ambiguous" ||
        intent.account_profile_id !== accountId ||
        intent.generation !== input.expectedGeneration ||
        intent.generation_contained !== 0 ||
        installed?.authorityHandle !== input.authorityHandle ||
        !sameArchiveDescriptor(
          providerThreadArchiveDescriptor(intent),
          input,
        )
      ) {
        throw new ChatPaneStoreError(
          "revision_conflict",
          "Provider archive containment no longer matches its durable intent.",
        );
      }
      return intent;
    };
    requireUncontainedIntent();
    await this.#handleAccountUnavailable(
      accountId,
      { expectedGeneration: input.expectedGeneration },
      "archiveGenerationContained",
    );
    requireUncontainedIntent();
    this.#store.markProviderThreadArchiveGenerationContained({
      paneId,
      expectedGeneration: input.expectedGeneration,
      containmentReceipt: contentFreeReceipt(
        "hra.chat.thread-archive-generation-contained.v1",
        JSON.stringify([
          accountId,
          paneId,
          input.expectedGeneration,
        ]),
      ),
      now: this.#now(),
    });
  }

  async #handleAccountUnavailable(
    accountProfileId: ChatAccountProfileId,
    options: Readonly<{
      readonly expectedGeneration?: number;
      readonly containmentTargetPaneIds?: readonly ChatPaneId[];
    }>,
    mode:
      | "archiveGenerationContained"
      | "explicitAccountRemoval"
      | "genericGenerationLoss",
  ): Promise<void> {
    const accountId = accountProfileIdSchema.parse(accountProfileId);
    const expectedGeneration = options.expectedGeneration;
    const containmentTargetPaneIds = new Set(
      (options.containmentTargetPaneIds ?? []).map((paneId) =>
        chatPaneIdSchema.parse(paneId)
      ),
    );
    if (
      expectedGeneration !== undefined &&
      (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1)
    ) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The unavailable provider generation is invalid.",
      );
    }
    if (mode === "genericGenerationLoss" && expectedGeneration === undefined) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Generic account cleanup requires the exact contained provider generation.",
      );
    }
    const preservedPaneIds = new Set<ChatPaneId>();
    if (mode !== "explicitAccountRemoval") {
      for (const paneId of this.#store.pendingProviderThreadArchivePaneIds()) {
        const intent = this.#store.providerThreadArchiveIntent(paneId);
        if (intent?.account_profile_id === accountId) preservedPaneIds.add(paneId);
      }
    }
    const paneIds = this.#store.paneIdsReferencingAccount(accountId)
      .filter((paneId) => !preservedPaneIds.has(paneId));
    await Promise.all(paneIds.map((paneId) => {
      return this.#serialize(paneId, async () => {
      const pane = this.#store.get(paneId);
      if (pane === null) return;
      if (
        mode !== "explicitAccountRemoval" &&
        (
          expectedGeneration === undefined ||
          !this.#paneProviderEffectBelongsToGeneration(
            paneId,
            accountId,
            expectedGeneration,
            containmentTargetPaneIds.has(paneId),
          )
        )
      ) return;
      this.#clearAttachedHarnessStartupRetry(paneId);
      this.#attachedHarnessProjectionFences.delete(paneId);
      this.#discardSessionProjectionQueue(paneId);
      const activeTurnId = activePane(pane.projection)
        ? pane.projection.turn?.id ?? null
        : null;
      if (pane.projection.turn !== null && activePane(pane.projection)) {
        if (pane.providerTurnId === null) {
          this.#settleUnacceptedRootTurnRouting(
            paneId,
            pane.projection.turn.id,
          );
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
          this.#settleRootTurnRouting(
            paneId,
            pane.projection.turn.id,
            "failed",
          );
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
      let quarantineAttachmentContext = false;
      let attachmentContainment: Readonly<{
        readonly bindingId: string;
        readonly bindingKeyDigest: string;
        readonly expectedRevision: number;
        readonly containmentReceipt: string;
      }> | null = null;
      const retainedClassification = this.#store
        .classifyRetainedProviderAttachmentBinding(paneId, pane.binding);
      const archiveIntent = this.#store.providerThreadArchiveIntent(paneId);
      if (
        archiveIntent !== null &&
        archiveIntent.state !== "account_contained"
      ) {
        if (archiveIntent.account_profile_id !== accountId) {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "A pending provider archive intent belongs to another account.",
          );
        }
        quarantineAttachmentContext = true;
      }
      if (retainedClassification.kind === "orphan") {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Attachment custody no longer matches this pane's provider lineage.",
        );
      }
      if (
        retainedClassification.kind === "exact" && this.#attachments === null
      ) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "The attachment containment authority is unavailable.",
        );
      }
      if (
        pane.binding !== null &&
        pane.binding.accountProfileId === accountId &&
        this.#attachments !== null
      ) {
        const authority = chatProviderAttachmentAuthority(
          paneId,
          pane.binding,
        );
        const retained = this.#attachments.readProviderBinding({
          ...authority,
          paneId,
        });
        if (retained !== null) {
          quarantineAttachmentContext = true;
          if (retained.state !== "released") {
            if (
              retainedClassification.kind !== "exact" ||
              retainedClassification.revision !== retained.revision
            ) {
              throw new ChatPaneStoreError(
                "revision_conflict",
                "Provider attachment custody changed during account containment.",
              );
            }
            attachmentContainment = Object.freeze({
              ...authority,
              expectedRevision: retained.revision,
              containmentReceipt: contentFreeReceipt(
                "hra.chat.account-generation-contained.v1",
                JSON.stringify([
                  accountId,
                  paneId,
                  pane.binding.threadId,
                  expectedGeneration ?? "account_unavailable",
                ]),
              ),
            });
          }
        }
      }
      this.#discardEarlySessionEvents(paneId);
      this.#observedSessionItemEvents.delete(paneId);
      this.#quotaProofFloors.delete(paneId);
      const detached = this.#store.detachUnavailableAccount(
        paneId,
        accountId,
        this.#now(),
        quarantineAttachmentContext
          ? "quarantineAttachments"
          : "preserveHandoff",
        attachmentContainment,
        quarantineAttachmentContext
          ? contentFreeReceipt(
              "hra.chat.account-generation-contained.v1",
              JSON.stringify([
                accountId,
                paneId,
                pane.binding?.threadId ?? "detached",
                expectedGeneration ?? "account_unavailable",
              ]),
            )
          : null,
      );
      if (
        mode === "explicitAccountRemoval" &&
        archiveIntent !== null &&
        archiveIntent.state !== "account_contained" &&
        this.#store.providerThreadArchiveIntent(paneId)?.state ===
          "account_contained"
      ) {
        this.#releaseProviderThreadArchiveHold(archiveIntent);
      }
      if (detached !== null) {
        if (activeTurnId !== null || quarantineAttachmentContext) {
          await this.#pauseMessageQueue(paneId, "attention");
        }
        await this.#projection.paneStateChanged(
          this.#store.require(paneId).projection,
        );
        if (activeTurnId !== null) {
          await this.#settleMessageLedgerForTerminal(paneId, activeTurnId);
        }
      }
      });
    }));
  }

  findByProviderThread(
    accountProfileId: ChatAccountProfileId,
    providerThreadId: string,
  ): ChatPanePrivateRecord | null {
    return this.#store.findByProviderThread(accountProfileId, providerThreadId);
  }

  /** Reports whether any pane, provider, projection, or persistence task remains active. */
  hasUnsettledWork(): boolean {
    return this.#accountArchiveTails.size > 0 ||
      this.#paneTails.size > 0 ||
      this.#providerEffects.size > 0 ||
      this.#sessionProjectionEventCount > 0 ||
      this.#pendingStreamPersistence.length > 0;
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
      const accountArchiveTails = [...this.#accountArchiveTails.values()];
      const tails = [...this.#paneTails.values()];
      const effects = [...this.#providerEffects];
      if (
        accountArchiveTails.length === 0 &&
        tails.length === 0 &&
        effects.length === 0 &&
        this.#sessionProjectionEventCount === 0 &&
        this.#pendingStreamPersistence.length === 0
      ) return;
      await Promise.all([
        ...accountArchiveTails.map((tail) => tail.catch(() => undefined)),
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
    // An early interaction belongs to an already-admitted provider-start tail.
    // Retain it so that tail can consume the exact rejection before settled()
    // releases shutdown; the ordinary terminal/poison cleanup then removes it.
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
        return this.#observeSessionDelta(
          base,
          "reasoningSummary",
          event.displayText,
          undefined,
          event.reasoningItemId,
        );
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
      effect: {
        type: "reasoning_item_completed",
        itemId: event.itemId,
        reasoningReceipt: event.receipt,
      },
    });
  }

  observeSessionProviderSubagents(event: SessionProviderSubagents): Promise<void> {
    return this.#observeSessionEvent({
      accountProfileId: event.accountProfileId,
      providerThreadId: event.threadId,
      providerTurnId: event.turnId,
      effect: { type: "provider_subagents", projection: event.projection },
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
      this.#poisonedTurns.get(pane.projection.id) === pane.projection.turn.id
    ) return false;
    if (pane.providerTurnId === null) {
      if (
        pane.projection.interactionMode !== "chat" ||
        pane.binding?.accountProfileId !== event.accountProfileId ||
        pane.binding.threadId !== event.threadId
      ) return false;
      if (
        this.#pendingTurnStops.get(pane.projection.id)?.turnId === pane.projection.turn.id ||
        this.#pendingTurnContainments.get(pane.projection.id)?.turnId ===
          pane.projection.turn.id
      ) return true;
      this.#latchEarlyUnexpectedInteraction(pane, event);
      return true;
    }
    if (pane.providerTurnId !== event.turnId) return false;
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
      case "chat.pane.schedule.configure":
        return this.#serializeScheduledChatCommand(command.paneId, async () => {
          const scheduledChats = this.#requireScheduledChats();
          const current = this.#requireScheduleConfigurationPane(
            command.paneId,
            command.expectedRevision,
          );
          const repository = await this.#resolveScheduledRepository(current);
          const candidates = await this.#accounts.refreshCandidates();
          const account = rankChatAccountCandidates(
            candidates,
            current.projection.accountProfileId,
            [],
          )[0];
          if (account === undefined) {
            throw new ChatPaneStoreError(
              "invalid_state",
              "No Codex account is currently available to interpret this schedule.",
            );
          }
          const timeZone = scheduledChatTimeZoneSchema.parse(
            Intl.DateTimeFormat().resolvedOptions().timeZone,
          );
          const now = this.#now();
          const interpreted = await this.#provider.interpretSchedule({
            accountProfileId: account.id,
            workingDirectory: repository.workingDirectory,
            instruction: command.instruction,
            timeZone,
            now: now.toISOString(),
          });
          const rrule = canonicalScheduledChatRRuleSchema.parse(
            interpreted.rrule,
          );
          const nextRunAt = nextScheduledChatOccurrence({
            rrule,
            timeZone,
            after: now.getTime(),
          });
          if (nextRunAt === null) {
            throw new ChatPaneStoreError(
              "invalid_state",
              "That instruction did not produce a future supported schedule.",
            );
          }
          this.#requireScheduleConfigurationPane(
            command.paneId,
            command.expectedRevision,
          );
          await scheduledChats.configure({
            paneId: command.paneId,
            expectedRevision: command.expectedRevision,
            prompt: interpreted.prompt,
            rrule,
            timeZone,
            now: now.getTime(),
          });
          const pane = this.#store.require(command.paneId).projection;
          await this.#projection.paneStateChanged(pane);
          return { type: "pane", pane };
        });
      case "chat.pane.schedule.remove":
        return this.#serializeScheduledChatCommand(command.paneId, async () => {
          const scheduledChats = this.#requireScheduledChats();
          const current = this.#store.require(command.paneId);
          const queue = current.projection.messageQueue;
          const scheduledBlockedMessage = queue.blockedMessage !== null
            && this.#isCurrentScheduledMessage(
              command.paneId,
              queue.blockedMessage.id,
            );
          if (
            current.projection.interactionMode !== "chat"
            || current.projection.revision !== command.expectedRevision
            || activePane(current.projection)
            || (queue.blockedMessage !== null && !scheduledBlockedMessage)
            || (queue.pauseReason !== null
              && queue.pauseReason !== "stop"
              && queue.pauseReason !== "runtimeRestart"
              && queue.pauseReason !== "attention"
              && !(
                queue.pauseReason === "ambiguousEffect"
                && scheduledBlockedMessage
              ))
            || queue.messages.some((message) =>
              !this.#isCurrentScheduledMessage(command.paneId, message.id)
            )
          ) {
            throw new ChatPaneStoreError(
              "invalid_state",
              "Stop the active occurrence and wait for any ambiguous provider effect before turning off this schedule.",
            );
          }
          await scheduledChats.remove({
            paneId: command.paneId,
            expectedRevision: command.expectedRevision,
            now: this.#now().getTime(),
          });
          const pane = this.#store.require(command.paneId).projection;
          if (
            pane.messageQueue.revision
              !== current.projection.messageQueue.revision
          ) {
            await this.#publishMessageQueue(command.paneId, pane.messageQueue);
          }
          await this.#projection.paneStateChanged(pane);
          return { type: "pane", pane };
        });
      case "chat.pane.workspace.recover":
        return this.#serialize(command.paneId, async () => {
          this.#assertScheduleAuthorityStable(command.paneId);
          const pane = this.#store.recoverWorkspace(
            command.paneId,
            command.expectedRevision,
            this.#now(),
          );
          await this.#projection.paneStateChanged(pane);
          if (pane.workspace?.state !== "ready") {
            this.#scheduleWorkspaceProvision(pane.id);
          }
          return { type: "pane", pane };
        });
      case "chat.pane.repository.select":
        return this.#serialize(command.paneId, async () => {
          this.#assertScheduleAuthorityStable(command.paneId);
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
        return this.#executePaneRemove(command);
      case "chat.panes.reorder":
        return Promise.resolve().then(async () => {
          const orderedPaneIds = this.#store.reorder(
            command.expectedOrderedPaneIds,
            command.orderedPaneIds,
          );
          await this.#projection.panesReordered(orderedPaneIds);
          return { type: "reordered" as const, orderedPaneIds };
        });
      case "chat.message.enqueue":
        return this.#serialize(command.paneId, async () => {
          this.#requireOrdinaryMessagePane(command.paneId);
          if (command.delivery.kind === "steerHead") {
            const prepared = this.#store.enqueueMessageAndPrepareSteer({
              paneId: command.paneId,
              expectedQueueRevision: command.expectedQueueRevision,
              messageId: command.messageId,
              content: command.content,
              turnId: command.delivery.expectedTurnId,
              now: this.#now(),
            });
            if (prepared.kind !== "prepared") {
              return {
                type: "messageQueue" as const,
                paneId: command.paneId,
                queue: prepared.queue,
                disposition: prepared.kind,
                messageId: command.messageId,
              };
            }
            const queue = await this.#publishAndDeliverPreparedSteer(
              prepared.claim,
              prepared.queue,
              "cancelNewMessage",
            );
            return {
              type: "messageQueue" as const,
              paneId: command.paneId,
              queue,
              disposition: "applied" as const,
              messageId: command.messageId,
            };
          }
          const enqueued = this.#store.enqueueMessageIdempotently({
            paneId: command.paneId,
            expectedQueueRevision: command.expectedQueueRevision,
            messageId: command.messageId,
            content: command.content,
            delivery: { kind: "queue" },
            now: this.#now(),
          });
          if (enqueued.disposition === "replayed") {
            return {
              type: "messageQueue" as const,
              paneId: command.paneId,
              queue: enqueued.queue,
              disposition: "replayed" as const,
              messageId: command.messageId,
            };
          }
          await this.#publishMessageQueue(command.paneId, enqueued.queue);
          const queue = await this.#admitNextQueuedMessage(command.paneId);
          return {
            type: "messageQueue" as const,
            paneId: command.paneId,
            queue,
            disposition: "applied" as const,
            messageId: command.messageId,
          };
        });
      case "chat.message.edit":
        return this.#serialize(command.paneId, async () => {
          this.#requireOrdinaryMessagePane(command.paneId);
          const edited = this.#store.editQueuedMessage({
            paneId: command.paneId,
            expectedQueueRevision: command.expectedQueueRevision,
            messageId: command.messageId,
            expectedMessageRevision: command.expectedMessageRevision,
            content: command.content,
            now: this.#now(),
          });
          await this.#publishMessageQueue(command.paneId, edited);
          const queue = await this.#admitNextQueuedMessage(command.paneId);
          return { type: "messageQueue" as const, paneId: command.paneId, queue };
        });
      case "chat.message.remove":
        return this.#serialize(command.paneId, async () => {
          this.#requireOrdinaryMessagePane(command.paneId);
          const removed = this.#store.removeQueuedMessage({
            paneId: command.paneId,
            expectedQueueRevision: command.expectedQueueRevision,
            messageId: command.messageId,
            expectedMessageRevision: command.expectedMessageRevision,
            now: this.#now(),
          });
          await this.#publishMessageQueue(command.paneId, removed);
          const queue = await this.#admitNextQueuedMessage(command.paneId);
          return { type: "messageQueue" as const, paneId: command.paneId, queue };
        });
      case "chat.messageQueue.resume":
        return this.#serialize(command.paneId, async () => {
          const current = this.#store.require(command.paneId);
          const scheduled = this.#scheduleAuthorityState(command.paneId);
          if (scheduled.pending || (
            scheduled.active
            && !this.#isScheduledMessage(
              command.paneId,
              current.projection.messageQueue.messages[0]?.id,
            )
            && !this.#isScheduledTurn(
              command.paneId,
              current.projection.turn?.id,
            )
          )) {
            throw new ChatPaneStoreError(
              "invalid_state",
              "Wait for the schedule change or its next scheduled message before resuming.",
            );
          }
          this.#requireOrdinaryMessagePane(command.paneId, scheduled.active);
          const resumed = this.#store.resumeMessageQueue({
            paneId: command.paneId,
            expectedQueueRevision: command.expectedQueueRevision,
            now: this.#now(),
          });
          await this.#publishMessageQueue(command.paneId, resumed);
          const queue = await this.#admitNextQueuedMessage(command.paneId);
          return { type: "messageQueue" as const, paneId: command.paneId, queue };
        });
      case "chat.pane.startFreshContext":
        return this.#executeStartFreshProviderContext(command);
      case "chat.message.discardAmbiguous":
        return this.#serialize(command.paneId, async () => {
          this.#requireOrdinaryMessagePane(command.paneId);
          const discarded = this.#store.discardAmbiguousMessage({
            paneId: command.paneId,
            expectedQueueRevision: command.expectedQueueRevision,
            messageId: command.messageId,
            expectedMessageRevision: command.expectedMessageRevision,
            now: this.#now(),
          });
          await this.#projection.paneChanged(
            this.#store.require(command.paneId).projection,
          );
          await this.#publishMessageQueue(command.paneId, discarded);
          const queue = await this.#admitNextQueuedMessage(command.paneId);
          return { type: "messageQueue" as const, paneId: command.paneId, queue };
        });
      case "chat.message.steerHead":
        return this.#serialize(command.paneId, async () => {
          this.#requireOrdinaryMessagePane(command.paneId);
          const prepared = this.#store.claimHeadMessage({
            paneId: command.paneId,
            expectedQueueRevision: command.expectedQueueRevision,
            messageId: command.messageId,
            expectedMessageRevision: command.expectedMessageRevision,
            turnId: command.expectedTurnId,
            kind: "steer",
            now: this.#now(),
          });
          const queue = await this.#publishAndDeliverPreparedSteer(
            prepared.claim,
            prepared.queue,
            "returnExistingMessage",
          );
          return { type: "messageQueue" as const, paneId: command.paneId, queue };
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
          if (
            current.projection.interactionMode === "chat"
            && this.#scheduledChatStore !== null
            && (
              this.#scheduledChatStore.get(command.paneId) !== null
              || this.#scheduledChatStore.mutationForPane(command.paneId) !== null
            )
          ) {
            throw new ChatPaneStoreError(
              "invalid_state",
              "This chat is scheduled. Turn off scheduling before sending manually.",
            );
          }
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
          if (!attachedActor && activePane(current.projection)) {
            if (
              current.projection.turn?.id === command.turnId &&
              current.activePrompt === command.prompt
            ) {
              throw new ChatPaneStoreError(
                "conflict",
                "This chat turn was already admitted.",
              );
            }
            throw new ChatPaneStoreError(
              "invalid_state",
              "This chat pane already has an active turn.",
            );
          }
          const now = this.#now();
          const admission = attachedActor
            ? this.#store.beginAttachedHarnessTurn({
                paneId: command.paneId,
                expectedRevision: command.expectedRevision,
                turnId: command.turnId,
                prompt: command.prompt,
                now,
              })
            : this.#store.beginTurn({
                paneId: command.paneId,
                expectedRevision: command.expectedRevision,
                turnId: command.turnId,
                prompt: command.prompt,
                now,
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
              if (!this.#trySettleContainedRootTurnRouting(
                command.paneId,
                command.turnId,
              )) return;
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
              if (this.#recoveryFencedTurns.get(command.paneId) === command.turnId) {
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
          const scheduled = this.#scheduleAuthorityState(command.paneId);
          if (scheduled.pending || (
            scheduled.active
            && !this.#isCurrentScheduledTurn(
              command.paneId,
              command.priorFailedTurnId,
            )
          )) {
            throw new ChatPaneStoreError(
              "invalid_state",
              "Only the exact failed scheduled occurrence can be retried while scheduling is on.",
            );
          }
          if (
            current.projection.interactionMode !== "chat" ||
            current.projection.workspace?.state !== "ready"
          ) {
            throw new ChatPaneStoreError(
              "invalid_state",
              "Create or recover this pane's isolated workspace before retrying.",
            );
          }
          if (current.activePrompt === null) {
            throw new ChatPaneStoreError(
              "invalid_state",
              "The failed turn has no recoverable prompt.",
            );
          }
          const now = this.#now();
          const admission = this.#store.retryTurn({
            paneId: command.paneId,
            expectedRevision: command.expectedRevision,
            priorFailedTurnId: command.priorFailedTurnId,
            turnId: command.turnId,
            now,
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
              if (!this.#trySettleContainedRootTurnRouting(
                command.paneId,
                command.turnId,
              )) return;
              try {
                await this.#settleHarnessBeforeProvider(
                  command.paneId,
                  command.turnId,
                  "provider_start_ambiguous",
                );
              } catch {
                return;
              }
              if (this.#recoveryFencedTurns.get(command.paneId) === command.turnId) {
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

  async enqueueScheduledOccurrence(
    occurrence: ChatScheduledOccurrence,
  ): Promise<void> {
    if (this.#admissionClosed) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Chat command admission is closed.",
      );
    }
    const scheduledStore = this.#scheduledChatStore;
    if (scheduledStore === null) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Scheduled chats are unavailable.",
      );
    }
    await this.#serializeCoordinatorScheduledPaneCallback(
      occurrence.paneId,
      async () => {
      const current = this.#requireOrdinaryMessagePane(
        occurrence.paneId,
        true,
      );
      const enqueued = scheduledStore.transaction(() =>
        scheduledStore.enqueueRunInTransaction<ChatMessageQueueProjection>({
          runId: occurrence.runId,
          paneId: occurrence.paneId,
          scheduleGeneration: positiveSyncUint64Schema.parse(
            occurrence.scheduleGeneration,
          ),
          occurrenceSequence: positiveSyncUint64Schema.parse(
            occurrence.occurrenceSequence,
          ),
          scheduledFor: occurrence.scheduledFor,
          definitionCiphertextDigest: syncSha256DigestSchema.parse(
            occurrence.definitionCiphertextDigest,
          ),
          now: this.#now().getTime(),
          enqueue: (messageId) => this.#store.enqueueMessageIdempotently({
            paneId: occurrence.paneId,
            expectedQueueRevision: current.projection.messageQueue.revision,
            messageId,
            content: { text: occurrence.prompt, attachmentRefs: [] },
            delivery: { kind: "queue" },
            now: this.#now(),
          }).queue,
        })
      );
      const queue = enqueued.value
        ?? this.#store.messageQueue(occurrence.paneId);
      await this.#publishMessageQueue(occurrence.paneId, queue);
      await this.#admitNextQueuedMessage(occurrence.paneId);
      },
    );
  }

  async commitScheduledChatPostimage(
    paneId: ChatPaneId,
    commit: () => void,
  ): Promise<void> {
    if (this.#admissionClosed) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Chat command admission is closed.",
      );
    }
    await this.#serializeCoordinatorScheduledPaneCallback(paneId, async () => {
      const recoveringTransition = this.#scheduledChatStore !== null
        && (
          this.#scheduledChatStore.mutationForPane(paneId) !== null
          || this.#scheduledChatStore.desiredOff(paneId) !== null
        );
      const beforeQueueRevision = this.#store.messageQueue(paneId).revision;
      commit();
      const pane = this.#store.require(paneId).projection;
      if (pane.messageQueue.revision !== beforeQueueRevision) {
        await this.#publishMessageQueue(paneId, pane.messageQueue);
      }
      await this.#projection.paneStateChanged(
        pane,
      );
      if (
        recoveringTransition
        && pane.workspace?.mode === "managedWorktree"
        && pane.workspace.state !== "preserved"
        && pane.workspace.state !== "ready"
      ) this.#scheduleWorkspaceProvision(paneId);
      if (recoveringTransition && pane.messageQueue.pauseReason === null) {
        await this.#admitNextQueuedMessage(paneId);
      }
    });
  }

  async resumeEligibleScheduledOccurrences(): Promise<void> {
    if (this.#admissionClosed) return;
    const scheduledStore = this.#scheduledChatStore;
    if (scheduledStore === null) return;
    const active = scheduledStore.activeSchedules();
    const activePaneIds = new Set(active.map(({ paneId }) => paneId));
    for (const paneId of this.#scheduledAttentionRetries.keys()) {
      if (!activePaneIds.has(paneId)) {
        this.#scheduledAttentionRetries.delete(paneId);
      }
    }
    for (const schedule of active) {
      const now = this.#now().getTime();
      const retry = this.#scheduledAttentionRetries.get(schedule.paneId);
      if (retry !== undefined && retry.notBefore > now) continue;
      await this.#serializeCoordinatorScheduledPaneCallback(
        schedule.paneId,
        async () => {
        const current = this.#store.get(schedule.paneId);
        const queue = current?.projection.messageQueue;
        if (
          current === null
          || queue === undefined
          || queue.pauseReason !== "attention"
          || queue.blockedMessage !== null
          || queue.messages.length === 0
          || queue.messages.some((message) =>
            !this.#isCurrentScheduledMessage(schedule.paneId, message.id)
          )
          || activePane(current.projection)
          || current.projection.workspace?.state !== "ready"
          || this.#scheduleAuthorityState(schedule.paneId).pending
        ) {
          if (queue?.pauseReason !== "attention") {
            this.#scheduledAttentionRetries.delete(schedule.paneId);
          }
          return;
        }
        const attempt = (retry?.attempt ?? 0) + 1;
        const delayMs = this.#scheduledAttentionRetryDelayMs(attempt);
        if (
          !Number.isSafeInteger(delayMs)
          || delayMs < 0
          || delayMs > MAX_SCHEDULED_ATTENTION_RETRY_MILLISECONDS
        ) {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "The scheduled chat attention retry delay is invalid.",
          );
        }
        this.#scheduledAttentionRetries.set(schedule.paneId, {
          attempt,
          notBefore: now + delayMs,
        });
        const resumed = this.#store.resumeMessageQueue({
          paneId: schedule.paneId,
          expectedQueueRevision: queue.revision,
          now: this.#now(),
        });
        await this.#publishMessageQueue(schedule.paneId, resumed);
        await this.#admitNextQueuedMessage(schedule.paneId);
        },
      );
    }
  }

  #requireScheduledChats(): ChatScheduledChatPort {
    if (this.#scheduledChats === null || this.#scheduledChatStore === null) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Scheduled chats require encrypted session sync.",
      );
    }
    return this.#scheduledChats;
  }

  #requireScheduleConfigurationPane(
    paneId: ChatPaneId,
    expectedRevision: number,
  ): ChatPanePrivateRecord {
    const pane = this.#store.require(paneId);
    if (
      pane.projection.revision !== expectedRevision
      || pane.projection.interactionMode !== "chat"
      || pane.projection.workspace?.state !== "ready"
      || activePane(pane.projection)
      || pane.projection.messageQueue.messages.length !== 0
      || pane.projection.messageQueue.pauseReason !== null
    ) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Finish current chat work before changing its schedule.",
      );
    }
    return pane;
  }

  async #resolveScheduledRepository(
    pane: ChatPanePrivateRecord,
  ): Promise<ChatRepository> {
    const source = await this.#repositories.resolve(
      pane.projection.repository.id,
    );
    if (source !== null && source.id === pane.projection.repository.id) {
      const repository = await this.#workspaces.resolve(
        pane.projection.id,
        source,
      );
      if (repository !== null && repository.id === source.id) return repository;
    }
    throw new ChatPaneStoreError(
      "invalid_state",
      "Restore this chat's workspace before changing its schedule.",
    );
  }

  #requireOrdinaryMessagePane(
    paneId: ChatPaneId,
    allowScheduled = false,
  ): ChatPanePrivateRecord {
    const pane = this.#store.require(paneId);
    if (pane.projection.interactionMode !== "chat") {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Persistent actor messages remain owned by their actor authority.",
      );
    }
    const scheduled = this.#scheduleAuthorityState(paneId);
    if (!allowScheduled && (scheduled.active || scheduled.pending)) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "This chat is scheduled. Turn off scheduling before editing its message queue.",
      );
    }
    return pane;
  }

  #scheduleAuthorityState(paneId: ChatPaneId): Readonly<{
    active: boolean;
    pending: boolean;
  }> {
    const store = this.#scheduledChatStore;
    return {
      active: store !== null && store.get(paneId) !== null,
      pending: store !== null && (
        store.mutationForPane(paneId) !== null
        || store.desiredOff(paneId) !== null
      ),
    };
  }

  #assertScheduleAuthorityStable(paneId: ChatPaneId): void {
    const state = this.#scheduleAuthorityState(paneId);
    if (state.active || state.pending) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Turn off scheduling before changing this chat's repository or workspace.",
      );
    }
  }

  #isScheduledMessage(
    paneId: ChatPaneId,
    messageId: ChatMessageId | undefined,
  ): boolean {
    return messageId !== undefined
      && this.#scheduledChatStore !== null
      && this.#scheduledChatStore.runForMessage(paneId, messageId) !== null;
  }

  #isCurrentScheduledMessage(
    paneId: ChatPaneId,
    messageId: ChatMessageId,
  ): boolean {
    const store = this.#scheduledChatStore;
    const schedule = store?.get(paneId) ?? null;
    const run = store?.runForMessage(paneId, messageId) ?? null;
    return schedule !== null
      && run !== null
      && run.sessionId === schedule.sessionId
      && run.scheduleGeneration === schedule.generation
      && run.cancelledAt === null;
  }

  #isScheduledTurn(
    paneId: ChatPaneId,
    turnId: string | undefined,
  ): boolean {
    return turnId !== undefined
      && this.#scheduledChatStore !== null
      && this.#scheduledChatStore.runForTurn(paneId, turnId) !== null;
  }

  #isCurrentScheduledTurn(
    paneId: ChatPaneId,
    turnId: string,
  ): boolean {
    const store = this.#scheduledChatStore;
    const schedule = store?.get(paneId) ?? null;
    const run = store?.runForTurn(paneId, turnId) ?? null;
    return schedule !== null
      && run !== null
      && run.sessionId === schedule.sessionId
      && run.scheduleGeneration === schedule.generation
      && run.cancelledAt === null;
  }

  async #publishMessageQueue(
    paneId: ChatPaneId,
    queue: ChatMessageQueueProjection,
  ): Promise<void> {
    await this.#projection.messageQueueChanged(paneId, queue);
  }

  async #pauseMessageQueue(
    paneId: ChatPaneId,
    reason: "stop" | "attention",
  ): Promise<ChatMessageQueueProjection> {
    const current = this.#store.messageQueue(paneId);
    if (
      current.pauseReason === "ambiguousEffect" ||
      current.pauseReason === reason
    ) return current;
    const paused = this.#store.pauseMessageQueue({
      paneId,
      reason,
      now: this.#now(),
    });
    await this.#publishMessageQueue(paneId, paused);
    return paused;
  }

  async #admitNextQueuedMessage(
    paneId: ChatPaneId,
  ): Promise<ChatMessageQueueProjection> {
    const current = this.#requireOrdinaryMessagePane(paneId, true);
    const queue = current.projection.messageQueue;
    const head = queue.messages[0];
    const scheduled = this.#scheduleAuthorityState(paneId);
    if (
      queue.pauseReason !== null || head === undefined ||
      scheduled.pending
      || (scheduled.active && !this.#isScheduledMessage(paneId, head.id)) ||
      activePane(current.projection) ||
      current.projection.workspace?.state !== "ready" ||
      this.#pendingTurnStops.has(paneId) ||
      this.#pendingTurnContainments.has(paneId) ||
      this.#recoveryFencedTurns.has(paneId) ||
      (head.text.trim().length === 0 && head.attachmentRefs.length === 0)
    ) return queue;
    if (this.#activeStartMessageEffects.has(paneId)) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "A prior app-owned message effect still owns this pane.",
      );
    }
    const turnId = newChatTurnId();
    const begun = this.#store.claimHeadMessageAndBeginTurn({
      paneId,
      expectedQueueRevision: queue.revision,
      messageId: head.id,
      expectedMessageRevision: head.revision,
      turnId,
      now: this.#now(),
    });
    this.#activeStartMessageEffects.set(paneId, {
      content: begun.claim.content,
      messageId: begun.claim.messageId,
      paneId,
      turnId,
      revision: begun.claim.revision,
      state: "claimed",
    });
    this.#attachedHarnessProjectionFences.delete(paneId);
    this.#attachedHarnessRecoveryRequestedTurns.delete(paneId);
    this.#discardSessionProjectionQueue(paneId);
    this.#discardEarlySessionEvents(paneId);
    this.#observedSessionItemEvents.delete(paneId);
    this.#quotaProofFloors.delete(paneId);
    this.#priorQuotaTerminals.delete(paneId);
    this.#exactProviderTerminalReceipts.delete(paneId);
    this.#poisonedTurns.delete(paneId);
    await this.#publishMessageQueue(paneId, begun.queue);
    await this.#projection.paneChanged(begun.pane);
    this.#scheduleClaimedStart(paneId, turnId);
    return begun.queue;
  }

  #scheduleClaimedStart(paneId: ChatPaneId, turnId: ChatTurnId): void {
    void this.#serialize(paneId, async () => {
      try {
        await this.#startLogicalTurn(paneId, turnId);
      } catch {
        if (this.#poisonedTurns.get(paneId) !== turnId) {
          if (this.#trySettleContainedRootTurnRouting(paneId, turnId)) {
            try {
              await this.#settleHarnessBeforeProvider(
                paneId,
                turnId,
                "provider_start_ambiguous",
              );
            } catch {
              return;
            }
            if (this.#recoveryFencedTurns.get(paneId) !== turnId) {
              await this.#publishAttention(paneId, turnId, {
                code: "runtime_unavailable",
                message: "The message delivery outcome needs attention before this queue can continue.",
                retryable: true,
              }, true);
            }
          }
        }
      }
      const settled = this.#store.get(paneId);
      if (
        settled !== null && settled.projection.turn?.id === turnId &&
        !activePane(settled.projection)
      ) {
        await this.#settleMessageLedgerForTerminal(paneId, turnId);
      }
    }).catch(() => {
      this.#poisonActiveTurnAndRequestRecovery(paneId, turnId);
    });
  }

  async #markStartMessageEffectStarted(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
  ): Promise<void> {
    const tracked = this.#activeStartMessageEffects.get(paneId);
    if (tracked === undefined) return;
    if (tracked.turnId !== turnId || tracked.state !== "claimed") {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The app-owned message no longer owns this provider attempt.",
      );
    }
    const queue = this.#store.markMessageEffectStarted({
      paneId,
      messageId: tracked.messageId,
      expectedMessageRevision: tracked.revision,
      turnId,
      kind: "start",
      now: this.#now(),
    });
    tracked.revision += 1;
    tracked.state = "effectStarted";
    await this.#publishMessageQueue(paneId, queue);
  }

  #acknowledgeStartMessageEffect(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
  ): ChatMessageQueueProjection | null {
    const tracked = this.#activeStartMessageEffects.get(paneId);
    if (tracked === undefined) return null;
    if (tracked.turnId !== turnId || tracked.state !== "effectStarted") {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The provider acknowledgement lost its app-owned message fence.",
      );
    }
    const queue = this.#store.acknowledgeMessageEffect({
      paneId,
      messageId: tracked.messageId,
      expectedMessageRevision: tracked.revision,
      turnId,
      kind: "start",
      now: this.#now(),
    });
    tracked.revision += 1;
    tracked.state = "acknowledged";
    return queue;
  }

  async #publishAndDeliverPreparedSteer(
    claim: ChatMessageClaim,
    preparedQueue: ChatMessageQueueProjection,
    preEffectFailure: "cancelNewMessage" | "returnExistingMessage",
  ): Promise<ChatMessageQueueProjection> {
    try {
      await this.#publishMessageQueue(claim.paneId, preparedQueue);
    } catch (error: unknown) {
      const settled = this.#settlePreparedSteerBeforeEffect(claim, preEffectFailure);
      try {
        await this.#publishMessageQueue(claim.paneId, settled.queue);
      } catch {
        // The durable queue is authoritative on the next snapshot.
      }
      if (!settled.attachmentsRestored) throw attachmentCompensationExpired();
      throw error;
    }
    return await this.#deliverPreparedSteer(claim, preEffectFailure);
  }

  #settlePreparedSteerBeforeEffect(
    claim: ChatMessageClaim,
    policy: "cancelNewMessage" | "returnExistingMessage",
  ): Readonly<{
    queue: ChatMessageQueueProjection;
    attachmentsRestored: boolean;
  }> {
    if (policy === "cancelNewMessage") {
      return this.#store.cancelPreparedSteerMessage({
        paneId: claim.paneId,
        messageId: claim.messageId,
        expectedMessageRevision: claim.revision,
        turnId: claim.turnId,
        kind: "steer",
        now: this.#now(),
      });
    }
    return {
      queue: this.#store.returnClaimedMessageToQueue({
        paneId: claim.paneId,
        messageId: claim.messageId,
        expectedMessageRevision: claim.revision,
        turnId: claim.turnId,
        kind: "steer",
        now: this.#now(),
      }),
      attachmentsRestored: true,
    };
  }

  async #deliverPreparedSteer(
    claim: ChatMessageClaim,
    preEffectFailure: "cancelNewMessage" | "returnExistingMessage",
  ): Promise<ChatMessageQueueProjection> {
    if (claim.kind !== "steer") {
      throw new ChatPaneStoreError("corrupt_state", "A steering claim changed kind.");
    }
    const pane = this.#store.require(claim.paneId);
    if (
      pane.projection.turn?.id !== claim.turnId ||
      !activePane(pane.projection) || pane.binding === null ||
      pane.providerTurnId === null ||
      this.#pendingTurnStops.has(claim.paneId) ||
      this.#pendingTurnContainments.has(claim.paneId) ||
      this.#recoveryFencedTurns.has(claim.paneId) ||
      (
        claim.content.text.trim().length === 0 &&
        claim.content.attachmentRefs.length === 0
      )
    ) {
      const settled = this.#settlePreparedSteerBeforeEffect(
        claim,
        preEffectFailure,
      );
      await this.#publishMessageQueue(claim.paneId, settled.queue);
      if (!settled.attachmentsRestored) throw attachmentCompensationExpired();
      throw new ChatPaneStoreError(
        "invalid_state",
        "The exact active turn is no longer ready for steering.",
      );
    }
    const fence = this.#provider.verifySteerTarget({
      ...pane.binding,
      turnId: pane.providerTurnId,
    });
    if (fence === null) {
      const settled = this.#settlePreparedSteerBeforeEffect(
        claim,
        preEffectFailure,
      );
      await this.#publishMessageQueue(claim.paneId, settled.queue);
      if (!settled.attachmentsRestored) throw attachmentCompensationExpired();
      throw new ChatPaneStoreError(
        "invalid_state",
        "The active turn no longer has HRA's verified execution policy.",
      );
    }
    try {
      if (claim.content.attachmentRefs.length > 0) {
        const projected = this.#attachments?.projectPane({
          paneId: claim.paneId,
          referencedAttachmentIds: claim.content.attachmentRefs,
          now: this.#now(),
        });
        if (projected === undefined) {
          throw new Error("Attachment delivery is unavailable.");
        }
        const carriesImage = projected.referenced.some((attachment) =>
          claim.content.attachmentRefs.includes(attachment.id) &&
          attachment.kind === "image"
        );
        if (carriesImage && !fence.allowsImage) {
          throw new Error("The active model receipt does not prove image input.");
        }
      }
    } catch {
      const settled = this.#settlePreparedSteerBeforeEffect(
        claim,
        preEffectFailure,
      );
      await this.#publishMessageQueue(claim.paneId, settled.queue);
      if (!settled.attachmentsRestored) throw attachmentCompensationExpired();
      throw new ChatPaneStoreError(
        "invalid_state",
        "The exact active model cannot accept these attachments.",
      );
    }
    let preparedInput: PreparedProviderAttachmentInput;
    try {
      preparedInput = await this.#prepareProviderAttachmentInput(
        claim.paneId,
        pane.binding,
        claim.content,
      );
    } catch {
      const settled = this.#settlePreparedSteerBeforeEffect(
        claim,
        preEffectFailure,
      );
      await this.#publishMessageQueue(claim.paneId, settled.queue);
      if (!settled.attachmentsRestored) throw attachmentCompensationExpired();
      throw new ChatPaneStoreError(
        "invalid_state",
        "The attachments could not be verified before steering.",
      );
    }
    const effectStarted = this.#store.markMessageEffectStarted({
      paneId: claim.paneId,
      messageId: claim.messageId,
      expectedMessageRevision: claim.revision,
      turnId: claim.turnId,
      kind: "steer",
      now: this.#now(),
    });
    const effectRevision = claim.revision + 1;
    let acknowledged: ChatMessageQueueProjection;
    let providerEffectAttempted = false;
    try {
      await this.#publishMessageQueue(claim.paneId, effectStarted);
      providerEffectAttempted = true;
      await this.#provider.steerTurn({
        binding: pane.binding,
        providerTurnId: pane.providerTurnId,
        messageId: claim.messageId,
        input: preparedInput.input,
        fence,
      });
      acknowledged = this.#store.acknowledgeMessageEffect({
        paneId: claim.paneId,
        messageId: claim.messageId,
        expectedMessageRevision: effectRevision,
        turnId: claim.turnId,
        kind: "steer",
        now: this.#now(),
      });
    } catch (error: unknown) {
      try {
        if (providerEffectAttempted && ambiguousProviderEffect(error)) {
          this.#markProviderAttachmentEffectAmbiguous(
            preparedInput.lease,
            `${claim.paneId}:${claim.turnId}:${claim.messageId}:steer`,
          );
        }
        const ambiguous = this.#store.markMessageEffectAmbiguous({
          paneId: claim.paneId,
          messageId: claim.messageId,
          expectedMessageRevision: effectRevision,
          turnId: claim.turnId,
          kind: "steer",
          now: this.#now(),
        });
        await this.#publishMessageQueue(claim.paneId, ambiguous);
      } catch {
        this.#poisonTurnAndRequestRecovery({
          paneId: claim.paneId,
          turnId: claim.turnId,
          accountProfileId: pane.binding.accountProfileId,
        });
      }
      throw new ChatPaneStoreError(
        "invalid_state",
        "The steering delivery outcome needs attention before this queue can continue.",
      );
    }
    await this.#publishMessageQueue(claim.paneId, acknowledged);
    return acknowledged;
  }

  async #settleMessageLedgerForTerminal(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
  ): Promise<ChatMessageQueueProjection> {
    const tracked = this.#activeStartMessageEffects.get(paneId);
    if (tracked?.turnId === turnId) {
      if (tracked.state === "claimed") {
        const queue = this.#store.returnClaimedMessageToQueue({
          paneId,
          messageId: tracked.messageId,
          expectedMessageRevision: tracked.revision,
          turnId,
          kind: "start",
          now: this.#now(),
        });
        this.#activeStartMessageEffects.delete(paneId);
        await this.#publishMessageQueue(paneId, queue);
      } else if (tracked.state === "effectStarted") {
        const queue = this.#store.markMessageEffectAmbiguous({
          paneId,
          messageId: tracked.messageId,
          expectedMessageRevision: tracked.revision,
          turnId,
          kind: "start",
          now: this.#now(),
        });
        tracked.revision += 1;
        tracked.state = "ambiguous";
        this.#activeStartMessageEffects.delete(paneId);
        await this.#publishMessageQueue(paneId, queue);
        return queue;
      }
    }
    const completed = this.#store.completeAcknowledgedMessagesForTurn(
      paneId,
      turnId,
      this.#now(),
    );
    this.#activeStartMessageEffects.delete(paneId);
    if (completed.completedCount > 0) {
      await this.#publishMessageQueue(paneId, completed.queue);
    }
    return completed.queue;
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
    reasoningItemId?: string,
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
        ...(reasoningItemId === undefined ? {} : { reasoningItemId }),
      },
    });
  }

  #observeSessionEvent(event: SessionEventEnvelope): Promise<void> {
    const pane = this.#chatPaneForSessionEvent(
      event.accountProfileId,
      event.providerThreadId,
      event.providerTurnId,
    );
    const exactTerminalReasoningRecovery =
      event.effect.type === "reasoning_item_completed" &&
      pane?.projection.turn?.status !== undefined &&
      ["completed", "failed"].includes(pane.projection.turn.status);
    if (
      pane === null ||
      (!activePane(pane.projection) && !exactTerminalReasoningRecovery) ||
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
    this.#earlyUnexpectedInteractions.delete(paneId);
    const paneBuffer = this.#earlySessionEvents.get(paneId);
    if (paneBuffer === undefined) return undefined;
    this.#earlySessionEvents.delete(paneId);
    this.#earlySessionEventCount -= paneBuffer.eventCount;
    this.#earlySessionEventUtf8Bytes -= paneBuffer.totalBytes;
    return paneBuffer;
  }

  #latchEarlyUnexpectedInteraction(
    pane: ChatPanePrivateRecord,
    event: SessionInteractionRequest,
  ): void {
    const logicalTurnId = pane.projection.turn?.id;
    if (logicalTurnId === undefined) return;
    const existing = this.#earlyUnexpectedInteractions.get(pane.projection.id);
    if (existing === undefined) {
      this.#earlyUnexpectedInteractions.set(pane.projection.id, {
        paneId: pane.projection.id,
        logicalTurnId,
        accountProfileId: event.accountProfileId,
        providerThreadId: event.threadId,
        providerTurnId: event.turnId,
        conflicted: false,
      });
      return;
    }
    if (
      existing.paneId !== pane.projection.id ||
      existing.logicalTurnId !== logicalTurnId ||
      existing.accountProfileId !== event.accountProfileId ||
      existing.providerThreadId !== event.threadId ||
      existing.providerTurnId !== event.turnId
    ) existing.conflicted = true;
  }

  #claimEarlyUnexpectedInteraction(
    paneId: ChatPaneId,
    logicalTurnId: ChatTurnId,
    binding: ChatThreadBinding,
    providerTurnId: string,
  ): "exact" | "conflicted" | null {
    const latch = this.#earlyUnexpectedInteractions.get(paneId);
    if (latch === undefined) return null;
    this.#earlyUnexpectedInteractions.delete(paneId);
    if (
      latch.conflicted ||
      latch.paneId !== paneId ||
      latch.logicalTurnId !== logicalTurnId ||
      latch.accountProfileId !== binding.accountProfileId ||
      latch.providerThreadId !== binding.threadId ||
      latch.providerTurnId !== providerTurnId
    ) return "conflicted";
    return "exact";
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
      if (event.effect.type === "terminal") {
        try {
          this.#settleRootTurnRouting(
            target.paneId,
            target.turnId,
            event.effect.quotaProof === "provider_rate_limit_reached"
              ? "quotaRejected"
              : event.effect.outcome === "completed"
                ? "succeeded"
                : event.effect.outcome,
          );
        } catch {
          // Containment below owns fail-closed recovery when evidence remains unavailable.
        }
      }
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
    const exactTerminalReasoningRecovery =
      event.effect.type === "reasoning_item_completed" &&
      pane?.projection.turn?.status !== undefined &&
      ["completed", "failed"].includes(pane.projection.turn.status);
    if (
      pane === null ||
      (!activePane(pane.projection) && !exactTerminalReasoningRecovery) ||
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
          ...(event.effect.reasoningItemId === undefined
            ? {}
            : { reasoningItemId: event.effect.reasoningItemId }),
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
        if (event.effect.reasoningReceipt === undefined) {
          throw new ChatPaneStoreError(
            "conflict",
            "The reasoning completion lost its verification receipt.",
          );
        }
        const changed = this.#store.reconcileReasoningCompletion({
          paneId,
          turnId,
          itemId: event.effect.itemId,
          receipt: event.effect.reasoningReceipt,
          now: this.#now(),
        });
        if (changed !== null) {
          await this.#projection.paneChanged(changed);
        }
        return;
      }
      case "provider_subagents": {
        const changed = this.#store.replaceProviderSubagents({
          paneId,
          turnId,
          projection: event.effect.projection,
          now: this.#now(),
        });
        if (changed !== null) await this.#projection.paneStateChanged(changed);
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
      this.#settleRootTurnRouting(
        event.paneId,
        event.turnId,
        "quotaRejected",
      );
      await this.#stopAfterProvenQuota(
        event.paneId,
        event.turnId,
        quotaLifecycle,
      );
      return;
    }
    this.#settleRootTurnRouting(
      event.paneId,
      event.turnId,
      event.outcome === "completed" ? "succeeded" : event.outcome,
    );
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
        const queue = await this.#settleMessageLedgerForTerminal(
          event.paneId,
          event.turnId,
        );
        if (queue.pauseReason === null) {
          await this.#admitNextQueuedMessage(event.paneId);
        }
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

  async #applyUnexpectedInteraction(
    event: ChatUnexpectedInteraction,
    containment: "exact" | "account_generation" = "exact",
  ): Promise<void> {
    const pane = this.#store.get(event.paneId);
    if (pane?.projection.turn?.id !== event.turnId || !activePane(pane.projection)) return;
    if (pane.projection.interactionMode === "harnessObserver") {
      // SessionService already rejects this interaction at the provider
      // boundary. The persistent actor owns any resulting cancellation,
      // terminal proof, and incarnation release; an ordinary chat interrupt
      // here would be an unjournaled second authority over the same turn.
      return;
    }
    const exactTarget = containmentTarget(pane);
    const target = containment === "exact"
      ? exactTarget
      : { ...exactTarget, providerTurnId: null };
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


    const currentQueue = this.#store.messageQueue(command.paneId);
    if (
      currentQueue.pauseReason !== "ambiguousEffect" &&
      currentQueue.pauseReason !== "stop"
    ) {
      const paused = this.#store.pauseMessageQueue({
        paneId: command.paneId,
        reason: "stop",
        now: this.#now(),
      });
      void this.#publishMessageQueue(command.paneId, paused).catch(() => {
        this.#poisonActiveTurnAndRequestRecovery(command.paneId, command.turnId);
      });
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
    let containedGeneration: number | null = null;
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
        containedGeneration = await this.#containAccountGeneration(
          accountProfileId,
          this.#providerGenerationForTurn(paneId, request.turnId),
        );
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
        this.#settleRootTurnRouting(paneId, request.turnId, "quotaRejected");
        await this.#observeHarnessTerminal(paneId, request.turnId, priorQuotaLifecycle);
      } else if (exactTerminalLifecycle !== null) {
        this.#settleRootTurnRouting(
          paneId,
          request.turnId,
          routingOutcomeForLifecycle(exactTerminalLifecycle),
        );
        await this.#observeHarnessTerminal(paneId, request.turnId, exactTerminalLifecycle);
      } else if (target.binding !== null && target.providerTurnId !== null) {
        this.#settleRootTurnRouting(paneId, request.turnId, "interrupted");
        await this.#observeHarnessTerminal(paneId, request.turnId, {
          accountProfileId: target.binding.accountProfileId,
          threadId: target.binding.threadId,
          turnId: target.providerTurnId,
          status: "interrupted",
        });
      } else {
        this.#settleUnacceptedRootTurnRouting(paneId, request.turnId);
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
    await this.#pauseMessageQueue(paneId, "stop");
    await this.#settleMessageLedgerForTerminal(paneId, request.turnId);
    if (generationFenced && accountProfileId !== null) {
      try {
        await this.#handleAccountUnavailable(
          accountProfileId,
          containedGeneration === null
            ? {}
            : {
                expectedGeneration: containedGeneration,
                containmentTargetPaneIds: [paneId],
              },
          "genericGenerationLoss",
        );
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
        if (poisoned !== null) await this.#projection.paneChanged(poisoned);
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
          const routing = this.#rootTurnRouting.readTurnRouting(
            target.paneId,
            target.turnId,
          );
          if (routing?.settledAt === null || routing === null) {
            throw new ChatPaneStoreError(
              "corrupt_state",
              "Terminal provider evidence could not settle root routing.",
            );
          }
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
            this.#settleRootTurnRouting(
              target.paneId,
              target.turnId,
              routingOutcomeForLifecycle(authoritativeLifecycle),
            );
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
            this.#settleContainedRootTurnRouting(
              target.paneId,
              target.turnId,
            );
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
      let containedGeneration: number;
      try {
        containedGeneration = await this.#containAccountGeneration(
          accountProfileId,
          this.#providerGenerationForTurn(target.paneId, target.turnId),
        );
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
          this.#settleContainedRootTurnRouting(
            target.paneId,
            target.turnId,
          );
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
        await this.#handleAccountUnavailable(
          accountProfileId,
          {
            expectedGeneration: containedGeneration,
            containmentTargetPaneIds: [target.paneId],
          },
          "genericGenerationLoss",
        );
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
      const routing = this.#rootTurnRouting.readTurnRouting(
        input.paneId,
        input.turnId,
      );
      if (routing !== null && routing.settledAt === null) {
        this.#rootTurnRouting.settle({
          paneId: input.paneId,
          chatTurnId: input.turnId,
          outcome: routing.effectStartedAt === null
            ? "notApplied"
            : routing.acceptedAt === null ? "ambiguous" : "interrupted",
          now: this.#now(),
        });
      }
    } catch {
      // Native rehydration remains mandatory when the routing ledger is unavailable.
    }
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
          await this.#projection.paneChanged(completed);
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
      this.#settleRootTurnRouting(paneId, turnId, "notApplied");
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
      this.#settleRootTurnRouting(paneId, turnId, "notApplied");
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
    if (
      previousBinding !== null &&
      previousBinding.accountProfileId !== account.id &&
      this.#attachments?.paneHasRetainedProviderBindings(paneId)
    ) {
      this.#settleRootTurnRouting(paneId, turnId, "notApplied");
      await this.#settleHarnessBeforeProvider(
        paneId,
        turnId,
        "provider_unavailable",
      );
      await this.#publishAttention(paneId, turnId, {
        code: "continuation_failed",
        message: "This pane retains attachment context from another Codex account. Reset or close the pane before switching accounts.",
        retryable: true,
      }, false);
      return;
    }
    const reserved = this.#store.reserveAccount(paneId, turnId, account.id, this.#now());
    await this.#projection.paneStateChanged(reserved);
    if (this.#turnStartupMustStop(paneId, turnId)) return;
    pane = this.#store.require(paneId);
    const plannedHandoff = previousBinding?.accountProfileId === account.id
      ? null
      : this.#store.handoffHistory(paneId, false);
    if (plannedHandoff !== null && !plannedHandoff.complete) {
      this.#settleRootTurnRouting(paneId, turnId, "notApplied");
      await this.#publishContextReset(paneId, turnId);
      return;
    }
    const handoffRequired = plannedHandoff !== null && plannedHandoff.items.length > 0;
    let handoffConfirmed = !handoffRequired;
    let providerTurnAttempted = false;
    let providerEffectStarted = false;
    try {
      if (this.#turnStartupMustStop(paneId, turnId)) return;
      const configuration = await this.#resolveRootTurnConfiguration(
        paneId,
        turnId,
        account.id,
      );
      if (this.#turnStartupMustStop(paneId, turnId)) return;
      await this.#markStartMessageEffectStarted(paneId, turnId);
      if (this.#turnStartupMustStop(paneId, turnId)) return;
      this.#rootTurnRouting.markEffectStarted({
        paneId,
        chatTurnId: turnId,
        now: this.#now(),
      });
      providerEffectStarted = true;
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
      const messageContent = this.#activeStartMessageEffects.get(paneId)?.content ?? {
        text: prompt,
        attachmentRefs: [],
      };
      const preparedInput = await this.#prepareProviderAttachmentInput(
        paneId,
        binding,
        messageContent,
      );
      if (
        configuration.requiredInputClass === "image" &&
        !preparedInput.input.some((item) => item.type === "localImage")
      ) {
        throw new ChatProviderEffectError({
          certainty: "not_applied",
          code: "capability_unavailable",
        });
      }
      if (this.#turnStartupMustStop(paneId, turnId)) return;
      providerTurnAttempted = true;
      let accepted: Awaited<ReturnType<ChatProviderPort["startTurn"]>>;
      try {
        accepted = await this.#startProviderTurn(
          {
            ...configuration,
            ...binding,
            clientTurnId: turnId,
            input: preparedInput.input,
            workingDirectory: repository.workingDirectory,
          },
          { paneId, turnId, binding, providerTurnId: null },
        );
      } catch (error: unknown) {
        if (ambiguousProviderEffect(error)) {
          this.#markProviderAttachmentEffectAmbiguous(
            preparedInput.lease,
            `${paneId}:${turnId}:start`,
          );
        }
        throw error;
      }
      if (this.#turnStartupMustStop(paneId, turnId)) return;
      try {
        this.#rootTurnRouting.accept({
          paneId,
          chatTurnId: turnId,
          acceptedGeneration: accepted.quotaProofCursor.generation,
          acceptedStreamPosition: accepted.quotaProofCursor.streamPosition,
          now: this.#now(),
        });
        const acknowledgedQueue = this.#acknowledgeStartMessageEffect(paneId, turnId);
        this.#rememberQuotaFloor(paneId, turnId, binding.accountProfileId, accepted.quotaProofCursor);
        const streaming = this.#store.markTurnAccepted(paneId, turnId, accepted.turnId, this.#now());
        const earlyInteraction = this.#claimEarlyUnexpectedInteraction(
          paneId,
          turnId,
          binding,
          accepted.turnId,
        );
        if (earlyInteraction !== null) {
          await this.#applyUnexpectedInteraction(
            { paneId, turnId },
            earlyInteraction === "exact" ? "exact" : "account_generation",
          );
          if (this.#turnStartupMustStop(paneId, turnId)) return;
        }
        if (acknowledgedQueue !== null) {
          await this.#publishMessageQueue(paneId, acknowledgedQueue);
        }
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
        if (
          providerEffectStarted &&
          !this.#trySettleContainedRootTurnRouting(paneId, turnId)
        ) {
          return;
        }
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
        const tracked = this.#activeStartMessageEffects.get(paneId);
        if (
          tracked !== undefined
          && tracked.turnId === turnId
          && tracked.state === "effectStarted"
          && this.#isCurrentScheduledMessage(paneId, tracked.messageId)
        ) {
          const queue = this.#store.settleProvenNotAppliedScheduledStart({
            paneId,
            messageId: tracked.messageId,
            expectedMessageRevision: tracked.revision,
            turnId,
            kind: "start",
            now: this.#now(),
          });
          this.#activeStartMessageEffects.delete(paneId);
          await this.#publishMessageQueue(paneId, queue);
        } else {
          this.#settleRootTurnRouting(paneId, turnId, "quotaRejected");
        }
        await this.#stopAfterProvenQuota(paneId, turnId, null);
        return;
      }
      if (
        providerEffectStarted && !providerTurnAttempted &&
        ambiguousProviderEffect(error)
      ) {
        let containedGeneration: number;
        try {
          containedGeneration = await this.#containAccountGeneration(
            account.id,
            this.#providerGenerationForTurn(paneId, turnId),
          );
        } catch {
          this.#trySettleRootTurnRouting(paneId, turnId, "ambiguous");
          this.#poisonTurnAndRequestRecovery({
            paneId,
            turnId,
            accountProfileId: account.id,
          });
          return;
        }
        void this.#handleAccountUnavailable(
          account.id,
          {
            expectedGeneration: containedGeneration,
            containmentTargetPaneIds: [paneId],
          },
          "genericGenerationLoss",
        ).catch(() => undefined);
      }
      this.#settleRootTurnRouting(
        paneId,
        turnId,
        !providerEffectStarted
          ? "notApplied"
          : ambiguousProviderEffect(error) ? "ambiguous" : "failed",
      );
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

  async #resolveRootTurnConfiguration(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
    accountProfileId: ChatAccountProfileId,
  ): Promise<ChatProviderResolvedConfiguration> {
    const pane = this.#store.require(paneId);
    if (
      pane.projection.turn?.id !== turnId ||
      !activePane(pane.projection)
    ) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The root route no longer owns an active chat turn.",
      );
    }
    const receipt = this.#rootTurnRouting.readTurnRouting(paneId, turnId);
    if (receipt === null) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The active ordinary root turn has no durable routing classification.",
      );
    }
    const candidates = rootTurnResolutionCandidates(
      receipt.requestedProfile,
      receipt.requestedServiceTier,
    ).map((candidate) => ({
      ...candidate,
      configuration: configurationFor(
        candidate.profile,
        candidate.serviceTier,
      ),
    }));
    const configuration = await this.#provider.resolveConfiguration(
      accountProfileId,
      candidates.map((candidate) => candidate.configuration),
      receipt.requiredInputClass,
    );
    const selected = candidates.find((candidate) =>
      sameConfiguration(candidate.configuration, configuration)
    );
    if (selected === undefined) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The provider resolved a configuration outside HRA's route.",
      );
    }
    if (receipt.selectedProfile === null) {
      this.#rootTurnRouting.resolve({
        paneId,
        chatTurnId: turnId,
        selectedProfile: selected.profile,
        profileFallbackReason: selected.profile === receipt.requestedProfile
          ? null
          : "lunaUnavailable",
        selectedServiceTier: selected.serviceTier,
        serviceTierFallbackReason:
          selected.serviceTier === receipt.requestedServiceTier
            ? null
            : "fastUnavailable",
        catalogGeneration: configuration.catalogGeneration,
        catalogDigest: configuration.catalogDigest,
        now: this.#now(),
      });
    } else if (
      receipt.selectedProfile !== selected.profile ||
      receipt.selectedServiceTier !== selected.serviceTier ||
      receipt.catalogGeneration !== configuration.catalogGeneration ||
      receipt.catalogDigest !== configuration.catalogDigest
    ) {
      throw new ChatPaneStoreError(
        "invalid_state",
        "The exact provider catalog no longer proves the durable root route.",
      );
    }
    return configuration;
  }

  #settleRootTurnRouting(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
    outcome: Parameters<RootTurnRoutingAuthorityV1["settle"]>[0]["outcome"],
  ): void {
    if (this.#store.get(paneId)?.projection.interactionMode === "harnessObserver") {
      return;
    }
    this.#rootTurnRouting.settle({
      paneId,
      chatTurnId: turnId,
      outcome,
      now: this.#now(),
    });
  }

  #trySettleRootTurnRouting(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
    outcome: Parameters<RootTurnRoutingAuthorityV1["settle"]>[0]["outcome"],
  ): void {
    try {
      this.#settleRootTurnRouting(paneId, turnId, outcome);
    } catch {
      this.#poisonActiveTurnAndRequestRecovery(paneId, turnId);
    }
  }

  #trySettleContainedRootTurnRouting(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
  ): boolean {
    try {
      this.#settleContainedRootTurnRouting(paneId, turnId);
      return true;
    } catch {
      this.#poisonActiveTurnAndRequestRecovery(paneId, turnId);
      return false;
    }
  }

  #settleContainedRootTurnRouting(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
  ): void {
    if (this.#store.get(paneId)?.projection.interactionMode === "harnessObserver") {
      return;
    }
    const receipt = this.#rootTurnRouting.readTurnRouting(paneId, turnId);
    if (receipt === null) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The contained ordinary root turn has no durable route receipt.",
      );
    }
    if (receipt.settledAt !== null) return;
    this.#settleRootTurnRouting(
      paneId,
      turnId,
      receipt.effectStartedAt === null
        ? "notApplied"
        : receipt.acceptedAt === null ? "ambiguous" : "interrupted",
    );
  }

  #settleUnacceptedRootTurnRouting(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
  ): void {
    if (this.#store.get(paneId)?.projection.interactionMode === "harnessObserver") {
      return;
    }
    const receipt = this.#rootTurnRouting.readTurnRouting(paneId, turnId);
    if (receipt === null) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The unavailable ordinary root turn has no durable route receipt.",
      );
    }
    if (receipt.settledAt !== null) return;
    this.#settleRootTurnRouting(
      paneId,
      turnId,
      receipt.effectStartedAt === null ? "notApplied" : "ambiguous",
    );
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
      let containedGeneration: number;
      try {
        containedGeneration = await this.#containAccountGeneration(
          request.accountProfileId,
          request.catalogGeneration,
        );
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
      void this.#handleAccountUnavailable(
        request.accountProfileId,
        {
          expectedGeneration: containedGeneration,
          containmentTargetPaneIds: [target.paneId],
        },
        "genericGenerationLoss",
      ).catch(() => undefined);
      throw error;
    }
  }

  async #executePaneRemove(
    command: Extract<ChatPaneCommand, { readonly type: "chat.pane.remove" }>,
  ): Promise<ChatCommandResult> {
    const pane = this.#store.preflightPaneArchive({
      paneId: command.paneId,
      expectedRevision: command.expectedRevision,
    });
    let containmentReceipt: string;
    if (pane.binding !== null) {
      if (!this.#providerThreadArchiveCoordinatorV57Enabled) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Closing a provider-bound pane is quarantined before provider access until exact archive recovery is available.",
        );
      }
      return await this.#executeLiveProviderThreadArchiveV57({
        accountProfileId: pane.binding.accountProfileId,
        binding: pane.binding,
        expectedQueueRevision: null,
        expectedRevision: command.expectedRevision,
        paneId: command.paneId,
        purpose: "pane_archive",
      });
    } else {
      const archiveIntent = this.#store.providerThreadArchiveIntent(command.paneId);
      if (archiveIntent?.state === "account_contained") {
        if (archiveIntent.generation_containment_receipt === null) {
          throw new ChatPaneStoreError(
            "corrupt_state",
            "Account-contained provider context lost its exact receipt.",
          );
        }
        containmentReceipt = archiveIntent.generation_containment_receipt;
      } else if (archiveIntent !== null) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Closing this pane requires its exact provider-containment recovery.",
        );
      } else if (this.#attachments?.paneHasRetainedProviderBindings(command.paneId)) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Attachment custody is retained by a provider thread whose containment is unknown.",
        );
      } else {
        containmentReceipt = contentFreeReceipt(
          "hra.chat.pane-without-provider-containment.v1",
          command.paneId,
        );
      }
    }

    return await this.#serialize(command.paneId, async () => {
      const now = this.#now();
      const removed = this.#store.remove(
        command.paneId,
        command.expectedRevision,
        now,
        containmentReceipt,
      );
      if (this.#attachments !== null) {
        try {
          await this.#attachments.archivePaneAfterResumeContained({
            paneId: command.paneId,
            now,
            containmentReceipt,
          });
        } catch {
          // The atomic pane/archive intent is authoritative. Boot
          // reconciliation resumes postcommit custody cleanup.
        }
      }
      this.#workspaces.release(command.paneId);
      this.#discardSessionProjectionQueue(command.paneId);
      this.#discardEarlySessionEvents(command.paneId);
      this.#observedSessionItemEvents.delete(command.paneId);
      this.#harnessRootTurns.delete(command.paneId);
      this.#quotaProofFloors.delete(command.paneId);
      this.#priorQuotaTerminals.delete(command.paneId);
      this.#exactProviderTerminalReceipts.delete(command.paneId);
      this.#activeStartMessageEffects.delete(command.paneId);
      this.#poisonedTurns.delete(command.paneId);
      this.#recoveryFencedTurns.delete(command.paneId);
      this.#attachedHarnessProjectionFences.delete(command.paneId);
      this.#attachedHarnessRecoveryRequestedTurns.delete(command.paneId);
      this.#clearAttachedHarnessStartupRetry(command.paneId);
      this.#clearWorkspaceResolutionRetry(command.paneId);
      await this.#projection.paneRemoved(removed.paneId, removed.revision);
      return { type: "removed" as const, ...removed };
    });
  }

  async #executeStartFreshProviderContext(
    command: Extract<
      ChatPaneCommand,
      { readonly type: "chat.pane.startFreshContext" }
    >,
  ): Promise<ChatCommandResult> {
    const current = this.#store.preflightStartFreshProviderContext({
      paneId: command.paneId,
      expectedRevision: command.expectedRevision,
      expectedQueueRevision: command.expectedQueueRevision,
    });
    if (current.binding !== null) {
      if (!this.#providerThreadArchiveCoordinatorV57Enabled) {
        throw new ChatPaneStoreError(
          "invalid_state",
          "Starting fresh from a provider-bound pane is quarantined before provider access until exact archive recovery is available.",
        );
      }
      return await this.#executeLiveProviderThreadArchiveV57({
        accountProfileId: current.binding.accountProfileId,
        binding: current.binding,
        expectedQueueRevision: command.expectedQueueRevision,
        expectedRevision: command.expectedRevision,
        paneId: command.paneId,
        purpose: "start_fresh",
      });
    }
    return await this.#serialize(command.paneId, async () => {
      const fresh = this.#store.startFreshProviderContext({
        paneId: command.paneId,
        expectedRevision: command.expectedRevision,
        expectedQueueRevision: command.expectedQueueRevision,
        now: this.#now(),
      });
      await this.#projection.paneChanged(fresh.pane);
      await this.#publishMessageQueue(command.paneId, fresh.queue);
      const queue = await this.#admitNextQueuedMessage(command.paneId);
      return {
        type: "messageQueue" as const,
        paneId: command.paneId,
        queue,
      };
    });
  }

  #scheduleProviderThreadArchiveRecoveryV57(
    inventory: ProviderThreadArchiveRecoveryInventoryV57,
  ): void {
    const accountIds = [...new Set(inventory.admissionDescriptors
      .filter((descriptor) => {
        const target = inventory.targets.find(({ targetId }) =>
          targetId === descriptor.transitionId
        );
        return target?.status === "open";
      })
      .map(({ accountProfileId }) =>
        accountProfileIdSchema.parse(accountProfileId)
    ))].sort();
    for (const accountProfileId of accountIds) {
      const effects = newProviderThreadArchiveRecoveryEffects();
      void this.#serializeArchiveAccountV57(accountProfileId, async () => {
        try {
          await this.#recoverProviderThreadArchiveAccountV57(
            accountProfileId,
            effects,
          );
        } finally {
          await this.#drainProviderThreadArchiveEffectPanesV57(effects);
        }
      }).then(
        async () => {
          await this.#publishProviderThreadArchiveRecoveryEffectsV57(effects);
        },
        async () => {
          await this.#publishProviderThreadArchiveRecoveryEffectsV57(effects);
        },
      ).catch(() => undefined);
    }
  }

  async #executeLiveProviderThreadArchiveV57(
    command: ProviderThreadArchiveLiveCommand,
  ): Promise<ChatCommandResult> {
    const targetId = newProviderThreadArchiveIdV57("archtarget_");
    const attemptId = newProviderThreadArchiveIdV57("archattempt_");
    const effects = newProviderThreadArchiveRecoveryEffects();
    let operationError: Error | null = null;
    try {
      await this.#serializeArchiveAccountV57(
        command.accountProfileId,
        async () => {
        try {
        const provisional = await this.#accounts
          .beginArchiveTransitionProvisional({
            accountProfileId: command.accountProfileId,
            paneId: command.paneId,
            purpose: command.purpose,
            transitionId: targetId,
          });
        let archiveHandle: ChatArchiveTransitionHandleV57;
        try {
          archiveHandle = await this.#withStableProviderArchivePaneBarrierV57(
            command.accountProfileId,
            [command.paneId],
            () => {
              this.#store.prepareProviderThreadArchiveEffectStartedV57({
                targetId,
                attemptId,
                paneId: command.paneId,
                expectedRevision: command.expectedRevision,
                generation: provisional.generation,
                now: this.#now(),
                ...(command.purpose === "pane_archive"
                  ? {
                      purpose: "pane_archive" as const,
                      expectedQueueRevision: null,
                    }
                  : {
                      purpose: "start_fresh" as const,
                      expectedQueueRevision:
                        command.expectedQueueRevision ?? invalidArchiveState(
                          "A start-fresh transition lost its queue revision.",
                        ),
                    }),
              });
              return this.#accounts.promoteArchiveTransitionEffectStarted(
                provisional.handle,
                targetId,
              );
            },
            effects,
          );
        } catch (error: unknown) {
          if (!this.#providerThreadArchiveTargetIsDurableV57(targetId)) {
            await this.#accounts.abortArchiveTransitionProvisional(
              provisional.handle,
            );
          }
          throw error;
        }

        // Hold the exact terminal component's pane tails before any provider
        // effect. These reservations stay drained through local finalization,
        // so a clean response has no later async gap before admission release.
        await this.#drainProviderThreadArchiveTerminalComponentPanesV57(
          targetId,
          effects,
        );

        let directApplied = false;
        let lostCause: "ambiguous_response" | "lost_response" =
          "lost_response";
        try {
          const response = validateProviderThreadArchiveDirectResponseV57(
            await this.#provider.archiveThread(
              this.#store.providerThreadArchiveTargetBindingV57(targetId),
              provisional.generation,
              archiveHandle,
            ),
            provisional.generation,
          );
          this.#store.recordProviderThreadArchiveDirectAppliedV57({
            targetId,
            responseGeneration: response.generation,
            responseStreamPosition: response.streamPosition,
            providerContainmentReceipt: response.containmentReceipt,
            now: this.#now(),
          });
          directApplied = true;
        } catch (error: unknown) {
          lostCause = error instanceof ChatProviderEffectError
            ? "lost_response"
            : "ambiguous_response";
          const target = this.#store.verifyProviderThreadArchiveRecoveryV57()
            .targets.find((candidate) => candidate.targetId === targetId) ??
              invalidArchiveState(
                "A provider archive target disappeared across its effect boundary.",
              );
          if (target.currentAttempt.state === "direct_applied") {
            directApplied = true;
          } else if (
            target.currentAttempt.state !== "effect_started" ||
            target.currentAttempt.cutId !== null
          ) {
            throw error;
          }
        }

        if (!directApplied) {
          const begun = this.#store.beginProviderThreadArchiveLostResponseCutV57({
            targetId,
            cutId: newProviderThreadArchiveIdV57("archcut_"),
            cause: lostCause,
            now: this.#now(),
          });
          this.#refreshProviderThreadArchiveCutHandlesV57(
            begun.cut.cutId,
            begun.affectedTargetIds,
            targetId,
            archiveHandle,
          );
          await this.#advanceProviderThreadArchiveCutV57(
            begun.cut,
            begun.affectedTargetIds,
            effects,
          );
        } else {
          archiveHandle = this.#accounts.replaceArchiveTransition(
            archiveHandle,
            targetId,
          );
          this.#finalizeProviderThreadArchiveTargetV57(
            targetId,
            effects,
            archiveHandle,
          );
        }
        } finally {
          await this.#drainProviderThreadArchiveEffectPanesV57(effects);
        }
        },
      );
    } catch (error: unknown) {
      operationError = providerThreadArchiveErrorV57(error);
    }
    let commandResults = new Map<string, ChatCommandResult>();
    let projectionError: Error | null = null;
    try {
      commandResults =
        await this.#publishProviderThreadArchiveRecoveryEffectsV57(effects);
    } catch (error: unknown) {
      projectionError = providerThreadArchiveErrorV57(error);
    }
    if (operationError !== null) throw operationError;
    if (projectionError !== null) throw projectionError;
    return commandResults.get(targetId) ?? invalidArchiveState(
      "The provider archive completed without its initiating local result.",
    );
  }

  async #recoverProviderThreadArchiveAccountV57(
    accountProfileId: ChatAccountProfileId,
    effects: ProviderThreadArchiveRecoveryEffects,
  ): Promise<void> {
    for (let pass = 0; pass < CHAT_MAX_PANES + 1; pass += 1) {
      const inventory = this.#store.verifyProviderThreadArchiveRecoveryV57();
      const descriptors = new Map(inventory.admissionDescriptors.map(
        (descriptor) => [descriptor.transitionId, descriptor] as const,
      ));
      const targets = inventory.targets.filter((target) =>
        target.status === "open" &&
        descriptors.get(target.targetId)?.accountProfileId === accountProfileId
      );
      if (targets.length === 0) return;

      const activeCut = inventory.activeCuts
        .filter((cut) =>
          cut.accountProfileId === accountProfileId &&
          cut.cause !== "account_removal"
        )
        .sort(compareProviderThreadArchiveCutsV57)[0];
      if (activeCut !== undefined) {
        await this.#advanceProviderThreadArchiveCutV57(
          activeCut,
          providerThreadArchiveTargetIdsForCutV57(targets, activeCut.cutId),
          effects,
        );
        continue;
      }

      const applied = targets.find(({ currentAttempt }) =>
        currentAttempt.state === "direct_applied" ||
        currentAttempt.state === "reconciled_applied"
      );
      if (applied !== undefined) {
        await this.#drainProviderThreadArchiveTerminalComponentPanesV57(
          applied.targetId,
          effects,
        );
        this.#finalizeProviderThreadArchiveTargetV57(
          applied.targetId,
          effects,
        );
        continue;
      }

      const effectStarted = targets.find(({ currentAttempt }) =>
        currentAttempt.state === "effect_started"
      );
      if (effectStarted !== undefined) {
        if (effectStarted.currentAttempt.cutId !== null) {
          invalidArchiveState(
            "A replayed provider archive effect retained an invalid cut binding.",
          );
        }
        const archiveHandle = this.#accounts.archiveTransitionHandleV57(
          effectStarted.targetId,
        );
        const begun = this.#store.beginProviderThreadArchiveLostResponseCutV57({
          targetId: effectStarted.targetId,
          cutId: newProviderThreadArchiveIdV57("archcut_"),
          cause: "lost_response",
          now: this.#now(),
        });
        this.#refreshProviderThreadArchiveCutHandlesV57(
          begun.cut.cutId,
          begun.affectedTargetIds,
          effectStarted.targetId,
          archiveHandle,
        );
        await this.#advanceProviderThreadArchiveCutV57(
          begun.cut,
          begun.affectedTargetIds,
          effects,
        );
        continue;
      }

      const ambiguous = targets.find(({ currentAttempt }) =>
        currentAttempt.state === "ambiguous" &&
        currentAttempt.cutId !== null
      );
      if (ambiguous !== undefined) {
        await this.#reconcileProviderThreadArchiveCutV57(
          ambiguous.currentAttempt.cutId ?? invalidArchiveState(
            "An ambiguous provider archive lost its containment cut.",
          ),
          effects,
        );
        continue;
      }

      const notApplied = targets.find(({ currentAttempt }) =>
        currentAttempt.state === "reconciled_not_applied"
      );
      if (notApplied !== undefined) {
        await this.#runProviderThreadArchiveSuccessorWaveV57(
          notApplied.currentAttempt.cutId ?? invalidArchiveState(
            "A not-applied provider archive lost its predecessor cut.",
          ),
          effects,
        );
        continue;
      }

      invalidArchiveState(
        "The provider archive recovery inventory contains a pre-effect or incoherent target.",
      );
    }
    invalidArchiveState(
      "Provider archive recovery exceeded its bounded transition count.",
    );
  }

  async #advanceProviderThreadArchiveCutV57(
    initialCut: ProviderThreadArchiveCutSnapshotV57,
    targetIdsValue: readonly string[],
    effects: ProviderThreadArchiveRecoveryEffects,
  ): Promise<void> {
    let cut = initialCut;
    const targetIds = [...new Set(targetIdsValue)].sort();
    if (targetIds.length === 0) {
      invalidArchiveState(
        "A provider archive cut lost its exact target cohort.",
      );
    }
    if (cut.cause === "account_removal") {
      invalidArchiveState(
        "ChatService cannot advance an account-removal archive cut.",
      );
    }
    if (cut.state === "fence_started") {
      const transitionId = targetIds[0] ?? invalidArchiveState(
        "A provider archive cut lost its initiating transition.",
      );
      const contained = await this.#accounts
        .containArchiveTransitionGenerationV57({
          accountProfileId: accountProfileIdSchema.parse(cut.accountProfileId),
          transitionId,
          cutId: cut.cutId,
          archiveHandle: this.#accounts.archiveTransitionHandleV57(
            transitionId,
          ),
        });
      if (contained.generation !== cut.sourceGeneration + 1) {
        invalidArchiveState(
          "The provider archive fence returned the wrong successor generation.",
        );
      }
      for (const targetId of targetIds) {
        this.#accounts.archiveTransitionHandleV57(targetId);
      }
      cut = this.#requireActiveProviderThreadArchiveCutV57(cut.cutId);
    }
    if (cut.state === "fenced") {
      cut = await this.#withStableProviderArchivePaneBarrierV57(
        accountProfileIdSchema.parse(cut.accountProfileId),
        this.#providerThreadArchiveTargetPaneIdsV57(targetIds),
        () => {
          const sealed = this.#store
            .sealProviderThreadArchiveSourceInventoryV57({
              cutId: cut.cutId,
              now: this.#now(),
            });
          this.#refreshProviderThreadArchiveCutHandlesV57(
            cut.cutId,
            targetIds,
          );
          return sealed;
        },
        effects,
      );
    }
    if (cut.state === "sealed") {
      for (const member of [...cut.members]
        .sort((left, right) => left.ordinal - right.ordinal)) {
        if (member.state === "settled") continue;
        const settled = this.#store.settleProviderThreadArchiveMemberV57({
          memberId: member.memberId,
          now: this.#now(),
        });
        effects.containedPaneIds.add(chatPaneIdSchema.parse(member.paneId));
        if (settled.pane !== null) {
          effects.containedPaneIds.add(settled.pane.id);
        }
        this.#refreshProviderThreadArchiveCutHandlesV57(
          cut.cutId,
          targetIds,
        );
      }
      cut = this.#store.markProviderThreadArchiveCutContainedV57({
        cutId: cut.cutId,
        now: this.#now(),
      });
      this.#refreshProviderThreadArchiveCutHandlesV57(
        cut.cutId,
        targetIds,
      );
    }
    if (cut.state !== "contained") {
      invalidArchiveState(
        "The provider archive cut did not reach exact containment.",
      );
    }
    await this.#reconcileProviderThreadArchiveCutV57(cut.cutId, effects);
  }

  async #reconcileProviderThreadArchiveCutV57(
    cutId: string,
    effects: ProviderThreadArchiveRecoveryEffects,
  ): Promise<void> {
    const initial = this.#store.verifyProviderThreadArchiveRecoveryV57();
    const descriptors = new Map(initial.admissionDescriptors.map(
      (descriptor) => [descriptor.transitionId, descriptor] as const,
    ));
    const targets = initial.targets.filter((target) =>
      target.status === "open" && target.currentAttempt.cutId === cutId
    ).sort(compareProviderThreadArchiveTargetsV57);
    if (targets.length === 0) {
      invalidArchiveState(
        "A contained provider archive cut lost its open target cohort.",
      );
    }
    await this.#drainProviderThreadArchiveTerminalComponentPanesV57(
      targets[0]?.targetId ?? invalidArchiveState(
        "A contained provider archive cut lost its terminal component.",
      ),
      effects,
    );
    const buffered = new Map<string, Readonly<{
      archiveHandle: ChatArchiveTransitionHandleV57;
      result: ReturnType<typeof validateProviderThreadArchiveReconciliationV57>;
    }>>();
    for (const target of targets) {
      if (target.currentAttempt.state === "reconciled_applied") continue;
      if (target.currentAttempt.state === "reconciled_not_applied") continue;
      if (target.currentAttempt.state !== "ambiguous") {
        invalidArchiveState(
          "A contained provider archive target is not reconcilable.",
        );
      }
      const descriptor = descriptors.get(target.targetId) ??
        invalidArchiveState(
          "A provider archive target lost its admission descriptor.",
        );
      const successorGeneration = descriptor.successorGeneration ??
        invalidArchiveState(
          "A contained provider archive target lost its successor generation.",
        );
      const archiveHandle = this.#accounts.archiveTransitionHandleV57(
        target.targetId,
      );
      const response = await this.#provider.reconcileThreadArchive(
        this.#store.providerThreadArchiveTargetBindingV57(target.targetId),
        archiveHandle,
      );
      const result = validateProviderThreadArchiveReconciliationV57(
        response,
        successorGeneration,
      );
      if (result.disposition === "ambiguous") {
        this.#store.recordProviderThreadArchiveReconciliationV57({
          targetId: target.targetId,
          result,
          now: this.#now(),
        });
        invalidArchiveState(
          "Provider archive reconciliation remained ambiguous.",
        );
      }
      buffered.set(target.targetId, { archiveHandle, result });
    }

    // No target authority is replaced or released until every reconciliation
    // response in this exact component is buffered. From here through all
    // applied-target commits and releases there is no provider await.
    const replacementHandles = new Map<
      string,
      ChatArchiveTransitionHandleV57
    >();
    for (const target of targets) {
      const outcome = buffered.get(target.targetId);
      if (outcome === undefined) continue;
      this.#store.recordProviderThreadArchiveReconciliationV57({
        targetId: target.targetId,
        result: outcome.result,
        now: this.#now(),
      });
      replacementHandles.set(
        target.targetId,
        this.#accounts.replaceArchiveTransition(
          outcome.archiveHandle,
          target.targetId,
        ),
      );
    }
    const afterOutcomes = this.#store.verifyProviderThreadArchiveRecoveryV57();
    const appliedTargets = afterOutcomes.targets.filter((target) =>
      target.status === "open" &&
      target.currentAttempt.cutId === cutId &&
      target.currentAttempt.state === "reconciled_applied"
    ).sort(compareProviderThreadArchiveTargetsV57);
    for (const target of appliedTargets) {
      this.#finalizeProviderThreadArchiveTargetV57(
        target.targetId,
        effects,
        replacementHandles.get(target.targetId),
      );
    }
    const after = this.#store.verifyProviderThreadArchiveRecoveryV57();
    const notApplied = after.targets.filter((target) =>
      target.status === "open" &&
      target.currentAttempt.cutId === cutId &&
      target.currentAttempt.state === "reconciled_not_applied"
    );
    if (notApplied.length > 0) {
      await this.#runProviderThreadArchiveSuccessorWaveV57(cutId, effects);
    }
  }

  async #runProviderThreadArchiveSuccessorWaveV57(
    cutId: string,
    effects: ProviderThreadArchiveRecoveryEffects,
  ): Promise<void> {
    const inventory = this.#store.verifyProviderThreadArchiveRecoveryV57();
    const descriptors = new Map(inventory.admissionDescriptors.map(
      (descriptor) => [descriptor.transitionId, descriptor] as const,
    ));
    const cohort = inventory.targets.filter((target) =>
      target.status === "open" &&
      target.currentAttempt.cutId === cutId &&
      target.currentAttempt.state === "reconciled_not_applied"
    ).sort(compareProviderThreadArchiveTargetsV57);
    if (cohort.length === 0) {
      invalidArchiveState(
        "The provider archive successor wave has no not-applied targets.",
      );
    }
    const activated = new Map<string, Readonly<{
      archiveHandle: ChatArchiveTransitionHandleV57;
      generation: number;
    }>>();
    for (const target of cohort) {
      const descriptor = descriptors.get(target.targetId) ??
        invalidArchiveState(
          "A provider archive successor lost its admission descriptor.",
        );
      const activation = await this.#accounts
        .activateArchiveTransitionSuccessorV57({
          accountProfileId: accountProfileIdSchema.parse(
            descriptor.accountProfileId,
          ),
          transitionId: target.targetId,
          archiveHandle: this.#accounts.archiveTransitionHandleV57(
            target.targetId,
          ),
        });
      if (activation.generation !== descriptor.successorGeneration) {
        invalidArchiveState(
          "A provider archive successor activated the wrong generation.",
        );
      }
      activated.set(target.targetId, activation);
    }
    const attempts = cohort.map((target) => Object.freeze({
      targetId: target.targetId,
      attemptId: newProviderThreadArchiveIdV57("archattempt_"),
    }));
    this.#store.appendProviderThreadArchiveSuccessorWaveEffectStartedV57({
      cutId,
      attempts,
      now: this.#now(),
    });
    await this.#drainProviderThreadArchiveTerminalComponentPanesV57(
      cohort[0]?.targetId ?? invalidArchiveState(
        "A provider archive successor wave lost its terminal component.",
      ),
      effects,
    );
    const handles = new Map<string, ChatArchiveTransitionHandleV57>();
    const responses = new Map<string, ProviderThreadArchiveDirectResponse>();
    let outcomesDurable = false;
    try {
      for (const target of cohort) {
        const prior = activated.get(target.targetId) ?? invalidArchiveState(
          "A provider archive successor lost its activated handle.",
        );
        handles.set(
          target.targetId,
          this.#accounts.replaceArchiveTransition(
            prior.archiveHandle,
            target.targetId,
          ),
        );
      }
      for (const target of cohort) {
        this.#store.assertProviderThreadArchiveSuccessorWaveReadyV57({ cutId });
        const generation = activated.get(target.targetId)?.generation ??
          invalidArchiveState(
            "A provider archive successor lost its exact generation.",
          );
        responses.set(
          target.targetId,
          validateProviderThreadArchiveDirectResponseV57(
            await this.#provider.archiveThread(
              this.#store.providerThreadArchiveTargetBindingV57(
                target.targetId,
              ),
              generation,
              handles.get(target.targetId) ?? invalidArchiveState(
                "A provider archive successor lost its effect handle.",
              ),
            ),
            generation,
          ),
        );
      }
      this.#store.recordProviderThreadArchiveDirectAppliedCohortV57({
        cutId,
        results: cohort.map((target) => {
          const response = responses.get(target.targetId) ??
            invalidArchiveState(
              "A successful provider archive wave lost a buffered response.",
            );
          return Object.freeze({
            targetId: target.targetId,
            responseGeneration: response.generation,
            responseStreamPosition: response.streamPosition,
            providerContainmentReceipt: response.containmentReceipt,
          });
        }),
        now: this.#now(),
      });
      outcomesDurable = true;
    } catch (error: unknown) {
      const afterFailure = this.#store.verifyProviderThreadArchiveRecoveryV57();
      const current = cohort.map(({ targetId }) =>
        afterFailure.targets.find((target) => target.targetId === targetId) ??
          invalidArchiveState(
            "A provider archive successor disappeared across its effect boundary.",
          )
      );
      if (current.every(({ currentAttempt }) =>
        currentAttempt.state === "direct_applied"
      )) {
        outcomesDurable = true;
      } else {
        if (current.some(({ currentAttempt }) =>
          currentAttempt.state !== "effect_started" ||
          currentAttempt.cutId !== null
        )) {
          throw error;
        }
        const initiating = current[0] ?? invalidArchiveState(
          "A failed provider archive successor wave lost its cohort.",
        );
        const priorHandle = handles.get(initiating.targetId) ??
          activated.get(initiating.targetId)?.archiveHandle ??
          invalidArchiveState(
            "A failed provider archive successor wave lost its handle.",
          );
        const begun = this.#store.beginProviderThreadArchiveLostResponseCutV57({
          targetId: initiating.targetId,
          cutId: newProviderThreadArchiveIdV57("archcut_"),
          cause: error instanceof ChatProviderEffectError
            ? "lost_response"
            : "ambiguous_response",
          now: this.#now(),
        });
        this.#refreshProviderThreadArchiveCutHandlesV57(
          begun.cut.cutId,
          begun.affectedTargetIds,
          initiating.targetId,
          priorHandle,
        );
        await this.#advanceProviderThreadArchiveCutV57(
          begun.cut,
          begun.affectedTargetIds,
          effects,
        );
        return;
      }
    }
    if (!outcomesDurable) {
      invalidArchiveState(
        "A provider archive successor wave lost its durable outcome.",
      );
    }
    for (const target of cohort) {
      handles.set(
        target.targetId,
        this.#accounts.replaceArchiveTransition(
          handles.get(target.targetId) ?? invalidArchiveState(
            "A successful provider archive wave lost its prior handle.",
          ),
          target.targetId,
        ),
      );
    }
    for (const target of cohort) {
      this.#finalizeProviderThreadArchiveTargetV57(
        target.targetId,
        effects,
        handles.get(target.targetId),
      );
    }
  }

  #finalizeProviderThreadArchiveTargetV57(
    targetId: string,
    effects: ProviderThreadArchiveRecoveryEffects,
    knownHandle?: ChatArchiveTransitionHandleV57,
  ): void {
    const targetExists = this.#store.verifyProviderThreadArchiveRecoveryV57()
      .targets.some((candidate) => candidate.targetId === targetId);
    if (!targetExists) {
      invalidArchiveState(
        "A provider archive target disappeared before finalization.",
      );
    }
    const reserved = this.#store
      .verifiedProviderThreadArchiveTerminalComponentV57(targetId);
    this.#assertProviderThreadArchiveTerminalComponentShapeV57(reserved);
    this.#assertProviderThreadArchiveTerminalComponentPanesDrainedV57(
      reserved,
      effects,
    );
    const result = this.#store.finalizeProviderThreadArchiveTargetV57({
      targetId,
      now: this.#now(),
    });
    const handle = knownHandle ??
      this.#accounts.archiveTransitionHandleV57(targetId);
    const discovered = this.#store
      .verifiedProviderThreadArchiveTerminalComponentV57(targetId);
    this.#assertProviderThreadArchiveTerminalComponentShapeV57(discovered);
    this.#assertProviderThreadArchiveTerminalComponentIdentityStableV57(
      reserved,
      discovered,
    );
    if (!discovered.component.allTargetsCommitted) {
      this.#recordProviderThreadArchiveFinalizationV57(
        effects,
        targetId,
        result,
      );
      const cleanup = this.#accounts.releaseArchiveTransition(
        targetId,
        handle,
        discovered.component,
      );
      this.#assertProviderThreadArchiveTerminalCleanupV57(
        discovered.component,
        cleanup,
      );
      return;
    }

    const harvested = this.#store
      .verifiedProviderThreadArchiveTerminalComponentV57(targetId);
    this.#assertProviderThreadArchiveTerminalComponentStableV57(
      discovered,
      harvested,
    );
    for (const finalization of harvested.finalizations) {
      this.#recordProviderThreadArchiveFinalizationV57(
        effects,
        finalization.targetId,
        finalization.result,
        finalization.paneId,
      );
    }
    const cleanup = this.#accounts.releaseArchiveTransition(
      targetId,
      handle,
      harvested.component,
    );
    this.#assertProviderThreadArchiveTerminalCleanupV57(
      harvested.component,
      cleanup,
    );
  }

  #recordProviderThreadArchiveFinalizationV57(
    effects: ProviderThreadArchiveRecoveryEffects,
    targetId: string,
    result: ChatProviderThreadArchiveFinalizationV57Result,
    expectedPaneId?: string,
  ): void {
    const paneId = result.kind === "pane_archive"
      ? result.removed.paneId
      : result.pane.id;
    if (
      expectedPaneId !== undefined &&
      paneId !== chatPaneIdSchema.parse(expectedPaneId)
    ) {
      invalidArchiveState(
        "A provider archive terminal replay changed its target pane.",
      );
    }
    const finalized = Object.freeze({ targetId, result });
    const existing = effects.finalized.findIndex((candidate) =>
      candidate.targetId === targetId
    );
    if (existing < 0) {
      effects.finalized.push(finalized);
    } else {
      effects.finalized[existing] = finalized;
    }
  }

  async #drainProviderThreadArchiveTerminalComponentPanesV57(
    targetId: string,
    effects: ProviderThreadArchiveRecoveryEffects,
  ): Promise<void> {
    const discovered = this.#store
      .verifiedProviderThreadArchiveTerminalComponentV57(targetId);
    this.#assertProviderThreadArchiveTerminalComponentShapeV57(discovered);
    for (const target of discovered.targets) {
      effects.containedPaneIds.add(chatPaneIdSchema.parse(target.paneId));
    }
    await this.#drainProviderThreadArchiveEffectPanesV57(effects);
    const drained = this.#store
      .verifiedProviderThreadArchiveTerminalComponentV57(targetId);
    this.#assertProviderThreadArchiveTerminalComponentShapeV57(drained);
    this.#assertProviderThreadArchiveTerminalComponentIdentityStableV57(
      discovered,
      drained,
    );
    if (
      discovered.component.allTargetsCommitted !==
        drained.component.allTargetsCommitted
    ) {
      invalidArchiveState(
        "A provider archive terminal component committed while its panes drained.",
      );
    }
    this.#assertProviderThreadArchiveTerminalComponentPanesDrainedV57(
      drained,
      effects,
    );
  }

  #assertProviderThreadArchiveTerminalComponentPanesDrainedV57(
    component: ChatProviderThreadArchiveTerminalComponentV57,
    effects: ProviderThreadArchiveRecoveryEffects,
  ): void {
    for (const target of component.targets) {
      const paneId = chatPaneIdSchema.parse(target.paneId);
      const reservation = effects.paneReservations.get(paneId);
      if (
        !effects.containedPaneIds.has(paneId) ||
        reservation === undefined || !reservation.drained
      ) {
        invalidArchiveState(
          "A provider archive terminal pane was not drained before finalization.",
        );
      }
    }
  }

  #assertProviderThreadArchiveTerminalComponentIdentityStableV57(
    prior: ChatProviderThreadArchiveTerminalComponentV57,
    current: ChatProviderThreadArchiveTerminalComponentV57,
  ): void {
    if (
      prior.component.accountProfileId !== current.component.accountProfileId ||
      !sameProviderThreadArchiveStringsV57(
        prior.component.targetIds,
        current.component.targetIds,
      ) ||
      !sameProviderThreadArchiveStringsV57(
        prior.component.cutIds,
        current.component.cutIds,
      ) ||
      prior.targets.length !== current.targets.length ||
      prior.targets.some((target, index) => {
        const observed = current.targets[index];
        return observed === undefined || observed.targetId !== target.targetId ||
          observed.paneId !== target.paneId;
      })
    ) {
      invalidArchiveState(
        "A provider archive terminal component changed identity before release.",
      );
    }
  }

  #assertProviderThreadArchiveTerminalComponentStableV57(
    discovered: ChatProviderThreadArchiveTerminalComponentV57,
    harvested: ChatProviderThreadArchiveTerminalComponentV57,
  ): void {
    this.#assertProviderThreadArchiveTerminalComponentShapeV57(harvested);
    if (
      !harvested.component.allTargetsCommitted ||
      discovered.component.accountProfileId !==
        harvested.component.accountProfileId ||
      !sameProviderThreadArchiveStringsV57(
        discovered.component.targetIds,
        harvested.component.targetIds,
      ) ||
      !sameProviderThreadArchiveStringsV57(
        discovered.component.cutIds,
        harvested.component.cutIds,
      ) ||
      discovered.targets.length !== harvested.targets.length ||
      discovered.targets.some((target, index) => {
        const current = harvested.targets[index];
        return current === undefined || current.targetId !== target.targetId ||
          current.paneId !== target.paneId;
      })
    ) {
      invalidArchiveState(
        "A provider archive terminal component changed before exact release.",
      );
    }
  }

  #assertProviderThreadArchiveTerminalComponentShapeV57(
    value: ChatProviderThreadArchiveTerminalComponentV57,
  ): void {
    if (
      value.component.targetIds.length === 0 ||
      value.targets.length !== value.component.targetIds.length ||
      value.targets.some((target, index) =>
        target.targetId !== value.component.targetIds[index] ||
        chatPaneIdSchema.safeParse(target.paneId).success === false
      ) ||
      (value.component.allTargetsCommitted
        ? value.finalizations.length !== value.targets.length ||
          value.finalizations.some((finalization, index) => {
            const target = value.targets[index];
            return target === undefined ||
              finalization.targetId !== target.targetId ||
              finalization.paneId !== target.paneId;
          })
        : value.finalizations.length !== 0)
    ) {
      invalidArchiveState(
        "A provider archive terminal component lost its canonical targets.",
      );
    }
  }

  #assertProviderThreadArchiveTerminalCleanupV57(
    component: ChatProviderThreadArchiveTerminalComponentV57["component"],
    cleanup: ReturnType<ChatAccountPort["releaseArchiveTransition"]>,
  ): void {
    const expectedTargetIds = component.allTargetsCommitted
      ? component.targetIds
      : [];
    const expectedCutIds = component.allTargetsCommitted
      ? component.cutIds
      : [];
    if (
      !sameProviderThreadArchiveStringsV57(
        cleanup.deletedTargetIds,
        expectedTargetIds,
      ) ||
      !sameProviderThreadArchiveStringsV57(
        cleanup.deletedCutIds,
        expectedCutIds,
      )
    ) {
      invalidArchiveState(
        "Provider archive terminal cleanup changed its exact component.",
      );
    }
  }

  #refreshProviderThreadArchiveCutHandlesV57(
    cutId: string,
    targetIdsValue: readonly string[],
    knownTransitionId?: string,
    knownHandle?: ChatArchiveTransitionHandleV57,
  ): void {
    const targetIds = [...new Set(targetIdsValue)].sort();
    const transitionId = knownTransitionId ?? targetIds[0] ??
      invalidArchiveState("A provider archive cut has no target handle.");
    const archiveHandle = knownHandle ??
      this.#accounts.archiveTransitionHandleV57(transitionId);
    this.#accounts.refreshArchiveTransitionCutAuthoritiesV57({
      archiveHandle,
      cutId,
      transitionId,
    });
    for (const targetId of targetIds) {
      this.#accounts.archiveTransitionHandleV57(targetId);
    }
  }

  #requireActiveProviderThreadArchiveCutV57(
    cutId: string,
  ): ProviderThreadArchiveCutSnapshotV57 {
    return this.#store.verifyProviderThreadArchiveRecoveryV57().activeCuts
      .find((candidate) => candidate.cutId === cutId) ?? invalidArchiveState(
        "The provider archive cut disappeared before containment completed.",
      );
  }

  #providerThreadArchiveTargetPaneIdsV57(
    targetIds: readonly string[],
  ): readonly ChatPaneId[] {
    const inventory = this.#store.verifyProviderThreadArchiveRecoveryV57();
    const targets = new Map(inventory.targets.map(
      (target) => [target.targetId, target] as const,
    ));
    return targetIds.map((targetId) =>
      chatPaneIdSchema.parse(
        targets.get(targetId)?.paneId ?? invalidArchiveState(
          "A provider archive cut lost its target pane.",
        ),
      )
    );
  }

  #providerThreadArchiveTargetIsDurableV57(targetId: string): boolean {
    try {
      return this.#store.verifyProviderThreadArchiveRecoveryV57().targets
        .some((target) => target.targetId === targetId);
    } catch {
      // If durable authority cannot be disproved, retain the provisional hold.
      return true;
    }
  }

  async #publishProviderThreadArchiveRecoveryEffectsV57(
    effects: ProviderThreadArchiveRecoveryEffects,
  ): Promise<Map<string, ChatCommandResult>> {
    const results = new Map<string, ChatCommandResult>();
    const finalizedPaneIds = new Set(effects.finalized.map(({ result }) =>
      result.kind === "pane_archive" ? result.removed.paneId : result.pane.id
    ));
    let firstError: Error | null = null;
    for (const paneId of [...effects.containedPaneIds].sort()) {
      if (finalizedPaneIds.has(paneId)) continue;
      try {
        await this.#runProviderThreadArchivePostcommitPaneV57(
          effects,
          paneId,
          async () => {
          const pane = this.#store.get(paneId);
          if (pane !== null) {
            await this.#projection.paneChanged(pane.projection);
          }
          },
        );
      } catch (error: unknown) {
        firstError ??= providerThreadArchiveErrorV57(error);
      }
    }
    for (const finalized of effects.finalized) {
      const result = finalized.result;
      if (result.kind === "pane_archive") {
        const { containmentReceipt, removed } = result;
        try {
          await this.#runProviderThreadArchivePostcommitPaneV57(
            effects,
            removed.paneId,
            async () => {
            if (this.#attachments !== null) {
              try {
                await this.#attachments.archivePaneAfterResumeContained({
                  paneId: removed.paneId,
                  now: this.#now(),
                  containmentReceipt,
                });
              } catch {
                // The pane commit owns a durable cleanup intent; startup resumes it.
              }
            }
            this.#workspaces.release(removed.paneId);
            this.#discardProviderThreadArchivePaneStateV57(removed.paneId);
            await this.#projection.paneRemoved(
              removed.paneId,
              removed.revision,
            );
            },
          );
        } catch (error: unknown) {
          firstError ??= providerThreadArchiveErrorV57(error);
        }
        results.set(finalized.targetId, {
          type: "removed",
          ...removed,
        });
        continue;
      }
      const fresh = result;
      try {
        const queue = await this.#runProviderThreadArchivePostcommitPaneV57(
          effects,
          fresh.pane.id,
          async () => {
            await this.#projection.paneChanged(fresh.pane);
            await this.#publishMessageQueue(
              fresh.pane.id,
              fresh.queue,
            );
            return await this.#admitNextQueuedMessage(
              fresh.pane.id,
            );
          },
        );
        results.set(finalized.targetId, {
          type: "messageQueue",
          paneId: fresh.pane.id,
          queue,
        });
      } catch (error: unknown) {
        firstError ??= providerThreadArchiveErrorV57(error);
        results.set(finalized.targetId, {
          type: "messageQueue",
          paneId: fresh.pane.id,
          queue: fresh.queue,
        });
      }
    }
    if (firstError !== null) throw firstError;
    return results;
  }

  #reserveProviderThreadArchiveEffectPanesV57(
    effects: ProviderThreadArchiveRecoveryEffects,
  ): void {
    const paneIds = new Set<ChatPaneId>(effects.containedPaneIds);
    for (const { result } of effects.finalized) {
      paneIds.add(
        result.kind === "pane_archive" ? result.removed.paneId : result.pane.id,
      );
    }
    for (const paneId of [...paneIds].sort()) {
      if (effects.paneReservations.has(paneId)) continue;
      const prior = this.#paneTails.get(paneId) ?? Promise.resolve();
      let release!: () => void;
      const marker = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = prior.catch(() => undefined).then(() => marker);
      this.#paneTails.set(paneId, tail);
      effects.paneReservations.set(paneId, {
        drained: false,
        paneId,
        prior,
        release,
        tail,
      });
    }
  }

  async #drainProviderThreadArchiveEffectPanesV57(
    effects: ProviderThreadArchiveRecoveryEffects,
  ): Promise<void> {
    this.#reserveProviderThreadArchiveEffectPanesV57(effects);
    await Promise.all([...effects.paneReservations.values()].map(
      async (reservation) => {
        if (reservation.drained) return;
        await reservation.prior.catch(() => undefined);
        reservation.drained = true;
      },
    ));
  }

  async #runProviderThreadArchivePostcommitPaneV57<T>(
    effects: ProviderThreadArchiveRecoveryEffects,
    paneIdValue: ChatPaneId,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const paneId = chatPaneIdSchema.parse(paneIdValue);
    const reservation = effects.paneReservations.get(paneId) ??
      invalidArchiveState(
        "A provider archive postcommit effect lost its pane reservation.",
      );
    if (!reservation.drained) {
      invalidArchiveState(
        "A provider archive postcommit pane was not drained before release.",
      );
    }
    effects.paneReservations.delete(paneId);
    await reservation.prior.catch(() => undefined);
    try {
      return await operation();
    } finally {
      reservation.release();
      if (this.#paneTails.get(paneId) === reservation.tail) {
        this.#paneTails.delete(paneId);
      }
    }
  }

  #discardProviderThreadArchivePaneStateV57(paneId: ChatPaneId): void {
    this.#discardSessionProjectionQueue(paneId);
    this.#discardEarlySessionEvents(paneId);
    this.#observedSessionItemEvents.delete(paneId);
    this.#harnessRootTurns.delete(paneId);
    this.#quotaProofFloors.delete(paneId);
    this.#priorQuotaTerminals.delete(paneId);
    this.#exactProviderTerminalReceipts.delete(paneId);
    this.#activeStartMessageEffects.delete(paneId);
    this.#poisonedTurns.delete(paneId);
    this.#recoveryFencedTurns.delete(paneId);
    this.#attachedHarnessProjectionFences.delete(paneId);
    this.#attachedHarnessRecoveryRequestedTurns.delete(paneId);
    this.#clearAttachedHarnessStartupRetry(paneId);
    this.#clearWorkspaceResolutionRetry(paneId);
  }

  async #withStableProviderArchivePaneBarrierV57<T>(
    accountProfileId: ChatAccountProfileId,
    requiredPaneIds: readonly ChatPaneId[],
    operation: () => T,
    effects?: ProviderThreadArchiveRecoveryEffects,
  ): Promise<T> {
    const accountId = accountProfileIdSchema.parse(accountProfileId);
    const reserved = new Map<ChatPaneId, ProviderThreadArchiveReservedPane>();
    const reserve = (paneIds: readonly ChatPaneId[]): void => {
      for (const paneIdValue of [...paneIds].sort()) {
        const paneId = chatPaneIdSchema.parse(paneIdValue);
        if (reserved.has(paneId)) continue;
        const postcommit = effects?.paneReservations.get(paneId);
        if (postcommit !== undefined) {
          if (!postcommit.drained) {
            invalidArchiveState(
              "A provider archive barrier reached an undrained postcommit pane.",
            );
          }
          continue;
        }
        const prior = this.#paneTails.get(paneId) ?? Promise.resolve();
        let release!: () => void;
        const marker = new Promise<void>((resolve) => {
          release = resolve;
        });
        const tail = prior.catch(() => undefined).then(() => marker);
        this.#paneTails.set(paneId, tail);
        reserved.set(paneId, { drained: false, paneId, prior, release, tail });
      }
    };
    reserve(requiredPaneIds);
    try {
      for (;;) {
        reserve(this.#store.paneIdsReferencingAccount(accountId));
        await Promise.all([...reserved.values()].map(({ prior }) =>
          prior.catch(() => undefined)
        ));
        const before = providerThreadArchiveBarrierPaneCountV57(
          reserved,
          effects?.paneReservations,
        );
        reserve(this.#store.paneIdsReferencingAccount(accountId));
        if (
          providerThreadArchiveBarrierPaneCountV57(
            reserved,
            effects?.paneReservations,
          ) === before
        ) return operation();
      }
    } finally {
      for (const reservation of reserved.values()) reservation.release();
      for (const reservation of reserved.values()) {
        if (this.#paneTails.get(reservation.paneId) === reservation.tail) {
          this.#paneTails.delete(reservation.paneId);
        }
      }
    }
  }

  #serializeArchiveAccountV57<T>(
    accountProfileId: ChatAccountProfileId,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const accountId = accountProfileIdSchema.parse(accountProfileId);
    const prior = this.#accountArchiveTails.get(accountId) ??
      Promise.resolve();
    let release!: () => void;
    const marker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.catch(() => undefined).then(() => marker);
    this.#accountArchiveTails.set(accountId, tail);
    return prior.catch(() => undefined).then(operation).finally(() => {
      release();
      if (this.#accountArchiveTails.get(accountId) === tail) {
        this.#accountArchiveTails.delete(accountId);
      }
    });
  }

  #retainProviderThreadArchiveHold(
    intent: ChatProviderThreadArchiveIntent,
  ): ProviderThreadArchiveHold {
    if (intent.state === "account_contained") {
      throw new ChatPaneStoreError(
        "invalid_state",
        "Account-contained provider context cannot retain live admission.",
      );
    }
    const descriptor = providerThreadArchiveDescriptor(intent);
    const authorityHandle = this.#accounts.retainArchiveGeneration(descriptor);
    if (
      authorityHandle.length < 16 ||
      authorityHandle.length > 512 ||
      authorityHandle.includes("\0")
    ) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "Provider archive admission returned an invalid authority handle.",
      );
    }
    const hold = Object.freeze({ authorityHandle, descriptor });
    this.#providerThreadArchiveHolds.set(intent.pane_id, hold);
    return hold;
  }

  #releaseProviderThreadArchiveHold(
    intent: ChatProviderThreadArchiveIntent,
  ): void {
    const hold = this.#providerThreadArchiveHolds.get(intent.pane_id);
    if (
      hold === undefined ||
      !sameArchiveDescriptor(
        hold.descriptor,
        providerThreadArchiveDescriptor(intent),
      )
    ) {
      throw new ChatPaneStoreError(
        "corrupt_state",
        "The provider archive admission hold no longer matches its durable row.",
      );
    }
    this.#releaseProviderThreadArchiveHoldByAuthority(hold);
  }

  #releaseProviderThreadArchiveHoldByAuthority(
    hold: ProviderThreadArchiveHold,
  ): void {
    this.#accounts.releaseArchiveGeneration({
      ...hold.descriptor,
      authorityHandle: hold.authorityHandle,
    });
    if (
      this.#providerThreadArchiveHolds.get(hold.descriptor.paneId)
        ?.authorityHandle === hold.authorityHandle
    ) {
      this.#providerThreadArchiveHolds.delete(hold.descriptor.paneId);
    }
  }

  #paneProviderEffectBelongsToGeneration(
    paneId: ChatPaneId,
    accountProfileId: ChatAccountProfileId,
    expectedGeneration: number,
    includeSettledExactTarget = false,
  ): boolean {
    const pane = this.#store.get(paneId);
    if (
      pane === null ||
      pane.projection.interactionMode !== "chat" ||
      pane.projection.turn === null
    ) return false;
    if (
      reservedContainmentAccount(pane, containmentTarget(pane)) !==
        accountProfileId
    ) return false;
    const routing = this.#rootTurnRouting.readTurnRouting(
      paneId,
      pane.projection.turn.id,
    );
    if (
      routing === null ||
      (
        routing.settledAt !== null && !includeSettledExactTarget &&
        !this.#store.hasUnsettledProviderEffectAuthorityV57(paneId)
      )
    ) return false;
    return routing.acceptedGeneration === expectedGeneration ||
      (
        routing.acceptedGeneration === null &&
        routing.effectStartedAt !== null &&
        routing.catalogGeneration === expectedGeneration
      );
  }

  #providerGenerationForTurn(
    paneId: ChatPaneId,
    turnId: ChatTurnId,
  ): number {
    const routing = this.#rootTurnRouting.readTurnRouting(paneId, turnId);
    const generation = routing?.acceptedGeneration ?? routing?.catalogGeneration;
    if (
      generation === null || generation === undefined ||
      !Number.isSafeInteger(generation) || generation < 1
    ) {
      throw new ChatContainmentFailure();
    }
    return generation;
  }

  async #prepareProviderAttachmentInput(
    paneId: ChatPaneId,
    binding: ChatThreadBinding,
    content: ChatMessageClaim["content"],
  ): Promise<PreparedProviderAttachmentInput> {
    const input: ChatProviderInput[] = [];
    if (content.text.trim().length > 0) {
      input.push({ type: "text", text: content.text });
    }
    if (content.attachmentRefs.length === 0) {
      if (input.length === 0) {
        throw new ChatProviderEffectError({
          certainty: "not_applied",
          code: "rejected",
        });
      }
      return Object.freeze({ input: Object.freeze(input), lease: null });
    }
    const attachments = this.#attachments;
    if (attachments === null) {
      throw new ChatProviderEffectError({
        certainty: "not_applied",
        code: "capability_unavailable",
      });
    }
    try {
      if (
        this.#store.requiredInputClassForAttachments(
          paneId,
          content.attachmentRefs,
        ) !== "image"
      ) {
        throw new Error("Attachment input did not require image capability.");
      }
    } catch {
      throw new ChatProviderEffectError({
        certainty: "not_applied",
        code: "capability_unavailable",
      });
    }
    const authority = chatProviderAttachmentAuthority(paneId, binding);
    let lease: ProviderAttachmentEffect;
    try {
      const acquired = attachments.acquireProviderLease({
        ...authority,
        paneId,
        attachmentIds: content.attachmentRefs,
        now: this.#now(),
      });
      lease = Object.freeze({
        ...authority,
        paneId,
        revision: acquired.revision,
      });
      for (const attachmentId of content.attachmentRefs) {
        const descriptor = await attachments.providerDescriptor({
          ...authority,
          paneId,
          attachmentId,
          now: this.#now(),
        });
        input.push(providerAttachmentInput(descriptor));
      }
    } catch {
      throw new ChatProviderEffectError({
        certainty: "not_applied",
        code: "runtime",
      });
    }
    return Object.freeze({ input: Object.freeze(input), lease });
  }

  #markProviderAttachmentEffectAmbiguous(
    lease: ProviderAttachmentEffect | null,
    effectIdentity: string,
  ): void {
    if (lease === null || this.#attachments === null) return;
    this.#attachments.markProviderBindingAmbiguous({
      ...lease,
      expectedRevision: lease.revision,
      ambiguityReceipt: contentFreeReceipt(
        "hra.chat.attachment-effect-ambiguous.v1",
        effectIdentity,
      ),
      now: this.#now(),
    });
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
    this.#settleRootTurnRouting(pane.projection.id, turnId, "notApplied");
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
    try {
      this.#rootTurnRouting.bindRootTurn({
        paneId: pane.projection.id,
        chatTurnId: turnId,
        rootTurnId: admitted.turnId,
        now: this.#now(),
      });
    } catch {
      try {
        await this.#awaitHarnessRootTransition(roots.settleBeforeProvider({
          turnId: admitted.turnId,
          paneId: pane.projection.id,
          failure: "provider_start_ambiguous",
          settledAt: this.#now().toISOString(),
        }));
      } catch {
        // Native recovery below owns both durable authorities.
      }
      this.#poisonActiveTurnAndRequestRecovery(pane.projection.id, turnId);
      throw new ChatContainmentFailure();
    }
    if (
      this.#admissionClosed ||
      this.#turnStartupMustStop(pane.projection.id, turnId)
    ) {
      this.#settleRootTurnRouting(
        pane.projection.id,
        turnId,
        "notApplied",
      );
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
      this.#settleRootTurnRouting(
        pane.projection.id,
        turnId,
        "notApplied",
      );
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

  async #containAccountGeneration(
    accountProfileId: ChatAccountProfileId,
    expectedGeneration: number,
  ): Promise<number> {
    const operation = this.#accounts.containAmbiguousEffect(
      accountProfileId,
      expectedGeneration,
    );
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
    const configuration = error instanceof ChatProviderEffectError &&
      (error.code === "configuration" || error.code === "capability_unavailable");
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
    if (pane !== null) {
      await this.#pauseMessageQueue(paneId, "attention");
      await this.#projection.paneChanged(pane);
      await this.#settleMessageLedgerForTerminal(paneId, turnId);
    }
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
    if (pane !== null) {
      await this.#pauseMessageQueue(paneId, "attention");
      await this.#projection.paneChanged(pane);
      await this.#settleMessageLedgerForTerminal(paneId, turnId);
    }
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
    const key = effect.type === "reasoning_item_completed"
      ? `${effect.type}:${effect.itemId}:${effect.reasoningReceipt?.receiptId ?? "missing"}`
      : `${effect.type}:${effect.itemId}`;
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
      if (projected.workspace?.state === "ready") {
        await this.#admitNextQueuedMessage(paneId);
      }
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

  async #serializeScheduledChatCommand<Value>(
    paneId: ChatPaneId,
    operation: () => Promise<Value>,
  ): Promise<Value> {
    const id = chatPaneIdSchema.parse(paneId);
    if (this.#scheduledChatCoordinatorReservations.has(id)) {
      throw new ChatPaneStoreError(
        "conflict",
        "Another scheduled-chat command already owns this pane.",
      );
    }
    const prior = this.#paneTails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const marker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.catch(() => undefined).then(() => marker);
    const reservation: ScheduledChatCoordinatorPaneReservation = {
      callbacks: new Set(),
      paneId: id,
      prior,
      release,
      tail,
    };
    this.#scheduledChatCoordinatorReservations.set(id, reservation);
    this.#paneTails.set(id, tail);
    try {
      await prior.catch(() => undefined);
      return await operation();
    } finally {
      while (reservation.callbacks.size > 0) {
        await Promise.all([...reservation.callbacks]);
      }
      if (this.#scheduledChatCoordinatorReservations.get(id) === reservation) {
        this.#scheduledChatCoordinatorReservations.delete(id);
      }
      release();
      if (this.#paneTails.get(id) === tail) this.#paneTails.delete(id);
    }
  }

  #serializeCoordinatorScheduledPaneCallback<Value>(
    paneId: ChatPaneId,
    operation: () => Value | Promise<Value>,
  ): Promise<Value> {
    const id = chatPaneIdSchema.parse(paneId);
    const reservation = this.#scheduledChatCoordinatorReservations.get(id);
    if (reservation !== undefined) {
      const result = reservation.prior.catch(() => undefined).then(operation);
      const tracked = result.then(
        () => undefined,
        () => undefined,
      );
      reservation.callbacks.add(tracked);
      void tracked.then(() => {
        reservation.callbacks.delete(tracked);
      });
      return result;
    }
    return this.#serialize(id, operation);
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

function newProviderThreadArchiveRecoveryEffects():
  ProviderThreadArchiveRecoveryEffects {
  return {
    containedPaneIds: new Set<ChatPaneId>(),
    finalized: [],
    paneReservations: new Map<ChatPaneId, ProviderThreadArchiveReservedPane>(),
  };
}

function sameProviderThreadArchiveStringsV57(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length && left.every((value, index) =>
    value === right[index]
  );
}

function newProviderThreadArchiveIdV57(
  prefix: "archattempt_" | "archcut_" | "archtarget_",
): string {
  return `${prefix}${randomBytes(24).toString("base64url")}`;
}

function validateProviderThreadArchiveDirectResponseV57(
  value: Readonly<{
    readonly containmentReceipt: string;
    readonly generation: number;
    readonly streamPosition: number;
  }>,
  expectedGeneration: number,
): ProviderThreadArchiveDirectResponse {
  if (
    value.generation !== expectedGeneration ||
    !Number.isSafeInteger(value.streamPosition) || value.streamPosition < 0 ||
    !validProviderThreadArchiveReceiptV57(value.containmentReceipt)
  ) {
    invalidArchiveState(
      "The provider archive returned an invalid exact-generation result.",
    );
  }
  return Object.freeze({
    containmentReceipt: value.containmentReceipt,
    generation: value.generation,
    streamPosition: value.streamPosition,
  });
}

function validateProviderThreadArchiveReconciliationV57(
  value: Awaited<ReturnType<ChatProviderPort["reconcileThreadArchive"]>>,
  expectedGeneration: number,
): ChatProviderThreadArchiveReconciliationV57 {
  if (
    value.generation !== expectedGeneration ||
    !Number.isSafeInteger(value.streamPosition) || value.streamPosition < 0 ||
    !validProviderThreadArchiveReceiptV57(value.evidenceReceipt)
  ) {
    invalidArchiveState(
      "The provider archive reconciliation returned invalid scan authority.",
    );
  }
  switch (value.disposition) {
    case "applied":
      if (
        value.containmentReceipt === null ||
        !validProviderThreadArchiveReceiptV57(value.containmentReceipt)
      ) {
        invalidArchiveState(
          "Applied provider archive reconciliation lacks containment authority.",
        );
      }
      return Object.freeze({
        disposition: "applied" as const,
        responseGeneration: value.generation,
        responseStreamPosition: value.streamPosition,
        providerContainmentReceipt: value.containmentReceipt,
      });
    case "not_applied":
      if (value.containmentReceipt !== null) {
        invalidArchiveState(
          "Not-applied provider archive reconciliation returned containment authority.",
        );
      }
      return Object.freeze({
        disposition: "not_applied" as const,
        providerReconciliationReceipt: value.evidenceReceipt,
      });
    case "ambiguous":
      if (value.containmentReceipt !== null) {
        invalidArchiveState(
          "Ambiguous provider archive reconciliation returned containment authority.",
        );
      }
      return Object.freeze({ disposition: "ambiguous" as const });
  }
}

function validProviderThreadArchiveReceiptV57(value: string): boolean {
  return value.length >= 16 && value.length <= 512 && !value.includes("\0");
}

function providerThreadArchiveTargetIdsForCutV57(
  targets: readonly ProviderThreadArchiveTargetSnapshotV57[],
  cutId: string,
): readonly string[] {
  return targets.filter((target) =>
    target.attempts.some((attempt) => attempt.cutId === cutId)
  ).map(({ targetId }) => targetId).sort();
}

function providerThreadArchiveBarrierPaneCountV57(
  reserved: ReadonlyMap<ChatPaneId, ProviderThreadArchiveReservedPane>,
  postcommit:
    | ReadonlyMap<ChatPaneId, ProviderThreadArchiveReservedPane>
    | undefined,
): number {
  return new Set([
    ...reserved.keys(),
    ...(postcommit?.keys() ?? []),
  ]).size;
}

function compareProviderThreadArchiveCutsV57(
  left: ProviderThreadArchiveCutSnapshotV57,
  right: ProviderThreadArchiveCutSnapshotV57,
): number {
  return left.sourceGeneration - right.sourceGeneration ||
    left.cutId.localeCompare(right.cutId);
}

function compareProviderThreadArchiveTargetsV57(
  left: ProviderThreadArchiveTargetSnapshotV57,
  right: ProviderThreadArchiveTargetSnapshotV57,
): number {
  return left.targetId.localeCompare(right.targetId);
}

function invalidArchiveState(message: string): never {
  throw new ChatPaneStoreError("invalid_state", message);
}

function providerThreadArchiveErrorV57(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("Provider archive recovery failed without an Error value.");
}

function attachedHarnessRetryDelay(attempt: number): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 16);
  return Math.min(
    MAX_ATTACHED_HARNESS_RETRY_MILLISECONDS,
    250 * 2 ** exponent,
  );
}

function newChatTurnId(): ChatTurnId {
  return chatTurnIdSchema.parse(
    `chatturn_${randomBytes(24).toString("base64url")}`,
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

function configurationFor(
  profile: ChatRootTurnProfile,
  serviceTier: "standard" | "fast",
): ChatProviderConfiguration {
  const selected = configurationForProfile(profile);
  return {
    ...selected,
    serviceTier,
  };
}

function sameConfiguration(
  left: ChatProviderConfiguration,
  right: ChatProviderConfiguration,
): boolean {
  return left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    (left.serviceTier ?? "standard") ===
      (right.serviceTier ?? "standard");
}

type RootTurnResolutionCandidate = Readonly<{
  profile: ChatRootTurnProfile;
  serviceTier: "standard" | "fast";
}>;

function rootTurnResolutionCandidates(
  requestedProfile: ChatRootTurnProfile,
  requestedServiceTier: "standard" | "fast",
): readonly RootTurnResolutionCandidate[] {
  if (requestedProfile === "lunaMax") {
    return requestedServiceTier === "fast"
      ? [
          { profile: "lunaMax", serviceTier: "fast" },
          { profile: "lunaMax", serviceTier: "standard" },
          { profile: "solMax", serviceTier: "fast" },
          { profile: "solMax", serviceTier: "standard" },
        ]
      : [
          { profile: "lunaMax", serviceTier: "standard" },
          { profile: "solMax", serviceTier: "standard" },
        ];
  }
  if (requestedProfile === "solMax" && requestedServiceTier === "fast") {
    return [
      { profile: "solMax", serviceTier: "fast" },
      { profile: "solMax", serviceTier: "standard" },
    ];
  }
  return [{ profile: requestedProfile, serviceTier: requestedServiceTier }];
}

function configurationForProfile(
  profile: ChatRootTurnProfile,
): Pick<ChatProviderConfiguration, "model" | "reasoningEffort"> {
  switch (profile) {
    case "lunaMax":
      return { model: "gpt-5.6-luna", reasoningEffort: "max" };
    case "solMax":
      return { model: "gpt-5.6-sol", reasoningEffort: "max" };
    case "solUltra":
      return { model: "gpt-5.6-sol", reasoningEffort: "ultra" };
  }
}

function provenQuotaRejection(error: unknown): boolean {
  return error instanceof ChatProviderEffectError &&
    error.certainty === "not_applied" &&
    error.code === "quota_reached" &&
    error.quotaProof === "provider_rate_limit_reached";
}

function routingOutcomeForLifecycle(
  lifecycle: SessionTurnLifecycle,
): "succeeded" | "failed" | "interrupted" | "quotaRejected" {
  if (lifecycle.quotaProof === "provider_usage_limit_exceeded") {
    return "quotaRejected";
  }
  switch (lifecycle.status) {
    case "completed": return "succeeded";
    case "failed": return "failed";
    case "interrupted": return "interrupted";
    case "inProgress":
      throw new ChatPaneStoreError(
        "invalid_state",
        "An in-progress provider lifecycle cannot settle root routing.",
      );
  }
}

function ambiguousProviderEffect(error: unknown): boolean {
  return !(error instanceof ChatProviderEffectError) || error.certainty === "ambiguous";
}

function attachmentCompensationExpired(): ChatPaneStoreError {
  return new ChatPaneStoreError(
    "invalid_state",
    "A prepared attachment expired before the atomic steer could be restored. Remove and reattach it before sending again.",
  );
}

function providerAttachmentInput(
  descriptor: ChatAttachmentProviderDescriptor,
): ChatProviderInput {
  if (descriptor.kind === "image") {
    return Object.freeze({ type: "localImage", path: descriptor.readPath });
  }
  throw new ChatProviderEffectError({
    certainty: "not_applied",
    code: "capability_unavailable",
  });
}

function contentFreeReceipt(domain: string, value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${domain}\0`);
  hasher.update(value);
  return hasher.digest("hex");
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

function providerThreadArchiveDescriptor(
  intent: ChatProviderThreadArchiveIntent,
): ChatArchiveRecoveryDescriptor {
  return Object.freeze({
    accountProfileId: intent.account_profile_id,
    expectedGeneration: intent.generation,
    expectedQueueRevision: intent.queue_revision,
    expectedRevision: intent.pane_revision,
    paneId: intent.pane_id,
    purpose: intent.purpose,
    restartThreadId: intent.restart_thread_id,
  });
}

function sameArchiveDescriptor(
  left: ChatArchiveRecoveryDescriptor,
  right: ChatArchiveRecoveryDescriptor,
): boolean {
  return left.accountProfileId === right.accountProfileId &&
    left.expectedGeneration === right.expectedGeneration &&
    left.expectedQueueRevision === right.expectedQueueRevision &&
    left.expectedRevision === right.expectedRevision &&
    left.paneId === right.paneId &&
    left.purpose === right.purpose &&
    left.restartThreadId === right.restartThreadId;
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
    case "provider_subagents":
      return utf8ByteLength(JSON.stringify(effect.projection));
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
