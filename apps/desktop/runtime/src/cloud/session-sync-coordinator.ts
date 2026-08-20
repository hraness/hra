import {
  SESSION_SYNC_PROTOCOL,
  canonicalSessionSyncJson,
  commitSyncVaultRootKey,
  canonicalScheduledChatRRuleSchema,
  clearOrphanedScheduledChatAsHumanRequestSchema,
  readScheduledChatRecoveryInventoryAsHumanRequestSchema,
  createSyncVaultRootKey,
  decodeSyncUint64,
  deriveSessionContentKey,
  digestSyncMembershipStatement,
  digestSyncRecoveryVaultRootWrap,
  digestSyncRequestBody,
  digestSyncVaultRootWrapManifest,
  encodeSyncUint64,
  generateSyncRecoveryKit,
  openSessionSummary,
  openScheduledChatDefinition,
  positiveSyncUint64Schema,
  publishSyncSessionRequestSchema,
  nextScheduledChatOccurrence,
  putScheduledChatRequestSchema,
  clearScheduledChatRequestSchema,
  acknowledgeScheduledChatRunRequestSchema,
  sealSessionSummary,
  sealScheduledChatDefinition,
  scheduledChatDefinitionHeaderSchema,
  scheduledChatDefinitionSchema,
  scheduledChatEpochMsSchema,
  scheduledChatTimeZoneSchema,
  sessionSummarySchema,
  sessionSyncHeaderSchema,
  signSyncMembershipStatement,
  syncBootIdSchema,
  syncDeviceIdSchema,
  syncMembershipHeadSchema,
  syncMembershipStatementSchema,
  syncRecoveryVaultRootWrapContextSchema,
  syncVaultCoordinateSchema,
  syncVaultRootWrapContextSchema,
  syncUint64Schema,
  wrapSyncVaultRootKey,
  wrapSyncVaultRootKeyForRecovery,
  type BootstrapSyncVaultRequest,
  type AcknowledgeScheduledChatRunRequest,
  type ClearScheduledChatRequest,
  MAX_SCHEDULED_CHAT_INVENTORY_PAGE_SIZE,
  MAX_SYNC_DIRECTORY_SESSIONS,
  type PositiveSyncUint64,
  type PutScheduledChatRequest,
  type ScheduledChatRun,
  type SessionPublicId,
  type SessionSyncBackendRequest,
  type SessionSyncBackendResponse,
  type SyncDeviceId,
  type SyncSha256Digest,
  type SyncMembershipHead,
  type SyncVaultCoordinate,
} from "@hraness/agent-tasks-protocol";
import {
  runtimeSessionSyncCapabilities,
  sessionSyncScheduledChatOrphanIdSchema,
  type RemoteSessionSummaryProjection,
  type RuntimeSessionSyncDomainCommand,
  type SessionSyncStatusProjection,
} from "../../../contracts/runtime";

import {
  openLocalSessionSyncIntentFromKeyring,
  sealLocalSessionSyncIntent,
  selectLocalSessionSyncRootKey,
  type LocalSessionSyncRootKeyring,
} from "./session-sync-local-crypto";
import {
  deriveSessionSyncHistoricalRootKey,
  validateAndUnwrapSessionSyncMembershipRoots,
  verifySessionSyncRootKeyChainToGenesis,
  type SessionSyncKeyCustody,
  type SessionSyncRecoveryKeyCustody,
  type SessionSyncRootKeyLinkPageExchange,
} from "./session-sync-key-custody";
import type {
  SessionSyncBearerClient,
  SessionSyncProofAuthority,
  SessionSyncSessionResult,
} from "./session-sync-http-client";
import {
  digestSessionSyncJournalValue,
  type SessionSyncOperationJournal,
  type SessionSyncOperationJournalEntry,
  type SessionSyncHumanOperation,
  type SessionSyncMutationKind,
} from "../state/session-sync-operation-journal";
import {
  SessionSyncStoreError,
  type EncryptedRemoteSessionRecord,
  type SessionSyncLocalPaneBindingAdmission,
  type SessionSyncStore,
  type SessionSyncRetryState,
  type SessionSyncHumanAuthority,
  type SessionSyncVaultState,
} from "../state/session-sync-store";
import type {
  ChatScheduledChatPort,
  ChatScheduledOccurrence,
} from "../chat/types";
import {
  ScheduledChatStoreError,
  type LocalScheduledChatDesiredOff,
  type LocalScheduledChatMutation,
  type ScheduledChatStore,
} from "../state/scheduled-chat-store";
import { abortableSleep } from "./abortable-sleep";

const WORKER_POLL_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const DIRECTORY_PAGE_SIZE = 100;
const ROOT_LINK_PAGE_SIZE = 100;
const RECOVERY_REVEAL_TTL_MS = 5 * 60_000;
const SCHEDULED_CHAT_RUN_PAGE_SIZE = 8;
const MAX_SCHEDULED_CHAT_PAGES_PER_CYCLE = 8;
const SCHEDULED_CHAT_INVENTORY_PAGE_SIZE = MAX_SCHEDULED_CHAT_INVENTORY_PAGE_SIZE;
const MAX_SCHEDULED_CHAT_RECOVERY_INVENTORY_PAGES = Math.ceil(
  MAX_SYNC_DIRECTORY_SESSIONS / MAX_SCHEDULED_CHAT_INVENTORY_PAGE_SIZE,
);

type SessionSyncWorker = SessionSyncRetryState["worker"];
type PendingSessionSyncEnrollment = Extract<
  SessionSyncBackendResponse,
  { kind: "enrollment_requests" }
>["requests"][number];

export interface SessionSyncHumanScope {
  readonly apiOrigin: string | null;
  readonly credentialGeneration: number;
  readonly signedIn: boolean;
  readonly userId: string | null;
  readonly organizationId: string | null;
}

function humanAuthorityFromScope(
  scope: SessionSyncHumanScope | null,
): SessionSyncHumanAuthority | null {
  if (
    scope?.signedIn !== true
    || scope.apiOrigin === null
    || scope.userId === null
    || scope.organizationId === null
    || scope.userId.length < 1
    || scope.organizationId.length < 1
  ) return null;
  return {
    apiOrigin: scope.apiOrigin,
    userId: scope.userId,
    organizationId: scope.organizationId,
  };
}

export function sessionSyncHumanAuthorityMatches(
  bound: SessionSyncHumanAuthority | null,
  scope: SessionSyncHumanScope | null,
): boolean {
  const current = humanAuthorityFromScope(scope);
  return bound !== null
    && current !== null
    && bound.apiOrigin !== null
    && bound.apiOrigin === current.apiOrigin
    && bound.userId === current.userId
    && bound.organizationId === current.organizationId;
}

function legacySessionSyncHumanAuthorityMatches(
  bound: SessionSyncHumanAuthority | null,
  scope: SessionSyncHumanScope | null,
): boolean {
  const current = humanAuthorityFromScope(scope);
  return bound !== null
    && bound.apiOrigin === null
    && current !== null
    && bound.userId === current.userId
    && bound.organizationId === current.organizationId;
}

export function assertStoredScheduledChatsCanSignOut(
  store: Pick<ScheduledChatStore, "hasAuthorityBearingState">,
): void {
  if (!store.hasAuthorityBearingState()) return;
  throw new SessionSyncCoordinatorError(
    "invalid_state",
    "Turn off scheduled chats before signing out of their cloud principal.",
  );
}

export interface SessionSyncProjectionPort {
  publish(event:
    | Readonly<{ type: "sessionSync.statusChanged"; status: SessionSyncStatusProjection }>
    | Readonly<{
        type: "sessionSync.localGrid.changed";
        slots: readonly Readonly<{ paneId: string; gridPosition: number }>[];
      }>
    | Readonly<{ type: "sessionSync.remote.upserted"; session: RemoteSessionSummaryProjection }>
    | Readonly<{ type: "sessionSync.remote.removed"; sessionId: string }>
    | Readonly<{ type: "sessionSync.remote.cleared" }>): void | Promise<void>;
}

export interface SessionSyncCoordinatorOptions {
  readonly store: SessionSyncStore;
  readonly journal: SessionSyncOperationJournal;
  readonly keyCustody: SessionSyncKeyCustody;
  readonly recoveryCustody: SessionSyncRecoveryKeyCustody;
  readonly client: SessionSyncBearerClient;
  readonly projection: SessionSyncProjectionPort;
  readonly cloudConfigured: boolean;
  readonly humanScope: () => SessionSyncHumanScope | null;
  readonly scheduledChatStore?: ScheduledChatStore;
  readonly enqueueScheduledOccurrence?: (
    occurrence: ChatScheduledOccurrence,
  ) => Promise<void>;
  readonly commitScheduledChatPostimage?: (
    paneId: string,
    commit: () => void,
  ) => Promise<void>;
  readonly resumeScheduledOccurrences?: () => Promise<void>;
  readonly now?: () => number;
  readonly random?: () => number;
}

export type SessionSyncCommandResult =
  | Readonly<{ type: "accepted" }>
  | Readonly<{
      type: "sessionSyncRecoveryKit";
      revealId: string;
      recoveryKit: string;
      expiresAt: number;
    }>;

export class SessionSyncCoordinatorError extends Error {
  readonly code:
    | "capability_unavailable"
    | "conflict"
    | "invalid_state"
    | "operation_failed"
    | "authority_mismatch"
    | "revision_conflict"
    | "upstream_ambiguous";
  readonly retryable: boolean;

  constructor(
    code: SessionSyncCoordinatorError["code"],
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = "SessionSyncCoordinatorError";
    this.code = code;
    this.retryable = retryable;
  }
}

class SessionSyncRemoteFailure extends Error {
  readonly code: string;
  readonly retryAfterMs: number | undefined;

  constructor(code: string, retryAfterMs?: number) {
    super("The encrypted session relay operation did not complete.");
    this.name = "SessionSyncRemoteFailure";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function randomOpaque(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function nowUint64(now: number): ReturnType<typeof encodeSyncUint64> {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError("Session sync time is invalid.");
  }
  return encodeSyncUint64(BigInt(now));
}

function nextPositiveSyncUint64(value: string): PositiveSyncUint64 {
  const next = decodeSyncUint64(value) + 1n;
  if (next > 18_446_744_073_709_551_615n) {
    throw new SessionSyncCoordinatorError(
      "invalid_state",
      "This scheduled chat exhausted its generation space.",
    );
  }
  return positiveSyncUint64Schema.parse(encodeSyncUint64(next));
}

function sameVault(
  left: SyncVaultCoordinate,
  right: SyncVaultCoordinate,
): boolean {
  return left.tenantId === right.tenantId
    && left.organizationId === right.organizationId
    && left.ownerUserId === right.ownerUserId
    && left.vaultId === right.vaultId
    && left.vaultGeneration === right.vaultGeneration;
}

function vaultFromHead(head: SyncMembershipHead): SyncVaultCoordinate {
  return syncVaultCoordinateSchema.parse({
    tenantId: head.statement.tenantId,
    organizationId: head.statement.organizationId,
    ownerUserId: head.statement.ownerUserId,
    vaultId: head.statement.vaultId,
    vaultGeneration: head.statement.vaultGeneration,
  });
}

function runtimeKeyring(
  value: NonNullable<Awaited<ReturnType<SessionSyncKeyCustody["loadRuntime"]>>["vaultRootKeyring"]>,
): LocalSessionSyncRootKeyring {
  return {
    vault: value.vault,
    currentRootKeyEpoch: value.currentRootKeyEpoch,
    rootKeys: value.rootKeys.map(({ keyEpoch, bytes }) => ({
      keyEpoch,
      rootKey: bytes,
    })),
  };
}

function retryCode(error: unknown): string {
  if (error instanceof SessionSyncRemoteFailure) return error.code;
  if (error instanceof SessionSyncStoreError) return "LOCAL_CORRUPT_STATE";
  if (error instanceof DOMException && error.name === "AbortError") {
    return "LOCAL_CANCELLED";
  }
  if (
    error instanceof Error
    && error.message.toLowerCase().includes("custody")
  ) return "LOCAL_KEYCHAIN_UNAVAILABLE";
  return "LOCAL_UNKNOWN";
}

function remoteRetryAfter(error: unknown): number | undefined {
  return error instanceof SessionSyncRemoteFailure
    ? error.retryAfterMs
    : undefined;
}

function accepted<Value>(result: SessionSyncSessionResult<Value>): Value {
  if (result.ok) return result.data;
  if (result.kind === "operation") {
    throw new SessionSyncRemoteFailure(
      result.error.code,
      result.error.retryAfterMs,
    );
  }
  throw new SessionSyncRemoteFailure(
    result.error.code === "SIGNED_OUT"
      ? "LOCAL_AUTH_UNAVAILABLE"
      : result.error.code,
  );
}

export class SessionSyncCoordinator implements ChatScheduledChatPort {
  readonly #client: SessionSyncBearerClient;
  readonly #cloudConfigured: boolean;
  readonly #humanScope: () => SessionSyncHumanScope | null;
  readonly #journal: SessionSyncOperationJournal;
  readonly #keyCustody: SessionSyncKeyCustody;
  readonly #now: () => number;
  readonly #projection: SessionSyncProjectionPort;
  readonly #random: () => number;
  readonly #recoveryCustody: SessionSyncRecoveryKeyCustody;
  readonly #scheduledChatStore: ScheduledChatStore | null;
  readonly #enqueueScheduledOccurrence:
    ((occurrence: ChatScheduledOccurrence) => Promise<void>) | null;
  readonly #commitScheduledChatPostimage:
    ((paneId: string, commit: () => void) => Promise<void>) | null;
  readonly #resumeScheduledOccurrences: (() => Promise<void>) | null;
  readonly #store: SessionSyncStore;
  #abort: AbortController | null = null;
  #activeExclusiveWork = 0;
  #activeOperations = 0;
  #admissionClosed = false;
  #commandTail: Promise<void> = Promise.resolve();
  #exclusiveTail: Promise<void> = Promise.resolve();
  #lastScopeFingerprint: string | null = null;
  #lastStatusJson: string | null = null;
  #localPaneBindingAdmission: SessionSyncLocalPaneBindingAdmission | null = null;
  #membershipResponse: Extract<SessionSyncBackendResponse, { kind: "membership" }> | null = null;
  #pendingEnrollments: Extract<SessionSyncBackendResponse, { kind: "enrollment_requests" }>["requests"] = [];
  #projectedRemote = new Map<string, string>();
  #orphanedScheduledChats = new Map<string, Readonly<{
    sessionId: SessionPublicId;
    paneId: string | null;
    originDeviceId: SyncDeviceId;
    generation: PositiveSyncUint64;
    ciphertextDigest: SyncSha256Digest;
  }>>();
  #scheduledChatRecoveryInventoryScope: string | null = null;
  #recoveryAcknowledged = false;
  #reveal: Readonly<{ id: string; value: string; expiresAt: number }> | null = null;
  #revealTimer: ReturnType<typeof setTimeout> | null = null;
  #scopeGeneration = 1;
  #restartRecovered = false;
  #tasks: Promise<void>[] = [];

  constructor(options: SessionSyncCoordinatorOptions) {
    this.#store = options.store;
    this.#journal = options.journal;
    this.#keyCustody = options.keyCustody;
    this.#recoveryCustody = options.recoveryCustody;
    this.#client = options.client;
    this.#projection = options.projection;
    this.#cloudConfigured = options.cloudConfigured;
    this.#humanScope = options.humanScope;
    const scheduledChatStore = options.scheduledChatStore ?? null;
    const enqueueScheduledOccurrence = options.enqueueScheduledOccurrence ?? null;
    const commitScheduledChatPostimage =
      options.commitScheduledChatPostimage ?? null;
    const resumeScheduledOccurrences = options.resumeScheduledOccurrences ?? null;
    if (
      (scheduledChatStore === null) !== (enqueueScheduledOccurrence === null)
      || (scheduledChatStore === null) !== (commitScheduledChatPostimage === null)
      || (scheduledChatStore === null) !== (resumeScheduledOccurrences === null)
    ) {
      throw new TypeError(
        "Scheduled chat storage, execution, and projection callbacks must be installed together.",
      );
    }
    this.#scheduledChatStore = scheduledChatStore;
    this.#enqueueScheduledOccurrence = enqueueScheduledOccurrence;
    this.#commitScheduledChatPostimage = commitScheduledChatPostimage;
    this.#resumeScheduledOccurrences = resumeScheduledOccurrences;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
  }

  start(): void {
    if (this.#admissionClosed) return;
    if (this.#abort !== null) return;
    this.#scheduledChatRecoveryInventoryScope = null;
    const abort = new AbortController();
    this.#abort = abort;
    this.#tasks = [this.#startWorkersAfterRecovery(abort.signal)];
    void this.#publishCurrentStatus().catch(() => undefined);
  }

  async #startWorkersAfterRecovery(signal: AbortSignal): Promise<void> {
    try {
      await this.#withExclusive(async () => {
        await this.#observeScope();
        await this.#recoverRestartWork(signal);
        await this.#discoverLocalOrphanedScheduledChats();
      });
    } catch (error) {
      if (signal.aborted) return;
      await this.#publishCurrentStatus(undefined, error).catch(() => undefined);
    }
    if (signal.aborted) return;
    await Promise.all(
      (["enrollment", "publisher", "observer", "heartbeat"] as const)
        .map((worker) => this.#workerLoop(worker, signal)),
    );
  }

  async stop(): Promise<void> {
    const abort = this.#abort;
    this.#clearReveal();
    if (abort === null) {
      await this.#clearRemoteProjection();
      return;
    }
    this.#abort = null;
    abort.abort();
    const tasks = this.#tasks;
    this.#tasks = [];
    await Promise.allSettled(tasks);
    await this.#clearRemoteProjection();
  }

  closeAdmission(): void {
    this.#admissionClosed = true;
    this.#abort?.abort();
  }

  async settled(): Promise<void> {
    for (;;) {
      const commandTail = this.#commandTail;
      const exclusiveTail = this.#exclusiveTail;
      const tasks = [...this.#tasks];
      await Promise.all([
        commandTail.catch(() => undefined),
        exclusiveTail.catch(() => undefined),
        ...tasks.map((task) => task.catch(() => undefined)),
      ]);
      if (
        this.#activeExclusiveWork === 0
        && this.#activeOperations === 0
        && commandTail === this.#commandTail
        && exclusiveTail === this.#exclusiveTail
      ) return;
    }
  }

  hasUnsettledWork(): boolean {
    return this.#activeExclusiveWork > 0 || this.#activeOperations > 0;
  }

  isScheduled(paneId: string): boolean {
    return this.#scheduledChatStore !== null
      && this.#scheduledChatStore.get(paneId) !== null;
  }

  orphanedScheduledChats(): Array<Readonly<{
    orphanId: string;
  }>> {
    return [...this.#orphanedScheduledChats.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([orphanId]) => ({ orphanId }));
  }

  async clearOrphanedScheduledChat(input: Readonly<{
    orphanId: string;
  }>): Promise<void> {
    try {
      await this.#withScheduledChatAuthorityTransition(async () => {
        const signal = this.#abort?.signal ?? new AbortController().signal;
        const orphanId = sessionSyncScheduledChatOrphanIdSchema.parse(
          input.orphanId,
        );
        const known = this.#orphanedScheduledChats.get(orphanId);
        if (known === undefined) {
          throw new SessionSyncCoordinatorError(
            "conflict",
            "The orphaned schedule changed; refresh its cloud inventory before clearing it.",
            true,
          );
        }
        const vault = this.#store.vault();
        if (
          vault?.state !== "active"
          || !sessionSyncHumanAuthorityMatches(
            vault.humanAuthority,
            this.#safeHumanScope(),
          )
        ) {
          throw new SessionSyncCoordinatorError(
            "invalid_state",
            "Restore the scheduled chat's cloud principal before clearing it.",
            true,
          );
        }
        const request = clearOrphanedScheduledChatAsHumanRequestSchema.parse({
          version: 1,
          operation: "clear_orphaned_scheduled_chat_as_human",
          ...vault.vault,
          originDeviceId: known.originDeviceId,
          sessionId: known.sessionId,
          expectedGeneration: known.generation,
          expectedCiphertextDigest: known.ciphertextDigest,
        });
        const response = accepted(await this.#client.clearOrphanedScheduledChat(
          request,
          signal,
        ));
        if (
          response.kind !== "scheduled_chat_cleared"
          || response.sessionId !== known.sessionId
          || response.generation !== known.generation
        ) {
          throw new SessionSyncCoordinatorError(
            "operation_failed",
            "The cloud returned another orphaned schedule generation.",
          );
        }
        if (known.paneId !== null) {
          const paneId = known.paneId;
          const schedules = this.#requireScheduledChatStore();
          const settleAt = this.#now();
          await this.#commitScheduledChatPostimageForPane(paneId, () => {
            schedules.transaction(() => {
              const recovered = this.#settlePendingScheduledMutationThroughHumanClear(
                schedules,
                paneId,
                known,
                "explicit_human_clear",
                settleAt,
              );
              if (!recovered) {
                schedules.reconcileInventoryEntryInTransaction({
                  paneId,
                  entry: {
                    state: "cleared",
                    sessionId: known.sessionId,
                    originDeviceId: known.originDeviceId,
                    generation: known.generation,
                  },
                  now: settleAt,
                });
              }
              this.#settlePendingScheduledRunAcknowledgmentsThroughHumanClear(
                schedules,
                paneId,
                known,
                "explicit_human_clear",
                settleAt,
              );
            });
          });
        }
        this.#orphanedScheduledChats.delete(orphanId);
        await this.#publishCurrentStatus();
      });
    } catch (error) {
      if (error instanceof SessionSyncCoordinatorError) throw error;
      if (error instanceof ScheduledChatStoreError) {
        throw new SessionSyncCoordinatorError(
          error.code === "conflict" ? "conflict" : "invalid_state",
          error.message,
          error.code === "conflict",
        );
      }
      throw error;
    }
  }

  assertScheduledChatsCanLoseSyncAuthority(): void {
    if (
      !this.#scheduledChatRecoveryInventoryIsCurrent()
      ||
      this.#scheduledChatStore?.hasAuthorityBearingState() === true
      || this.#orphanedScheduledChats.size > 0
    ) {
      throw new SessionSyncCoordinatorError(
        "invalid_state",
        "Turn off scheduled chats before changing session sync authority.",
      );
    }
  }

  assertScheduledChatsCanSelectOrganization(organizationId: string): void {
    if (
      this.#scheduledChatRecoveryInventoryIsCurrent()
      &&
      this.#scheduledChatStore?.hasAuthorityBearingState() !== true
      && this.#orphanedScheduledChats.size === 0
    ) return;
    const bound = this.#store.vault()?.humanAuthority ?? null;
    if (bound === null || bound.organizationId !== organizationId) {
      throw new SessionSyncCoordinatorError(
        "invalid_state",
        "Restore the scheduled chats' original organization or turn off scheduled chats first.",
      );
    }
  }

  assertScheduledChatsCanSignOut(): void {
    if (
      this.#scheduledChatRecoveryInventoryIsCurrent()
      &&
      this.#scheduledChatStore?.hasAuthorityBearingState() !== true
      && this.#orphanedScheduledChats.size === 0
    ) return;
    const bound = this.#store.vault()?.humanAuthority ?? null;
    if (sessionSyncHumanAuthorityMatches(bound, this.#safeHumanScope())) {
      throw new SessionSyncCoordinatorError(
        "invalid_state",
        "Turn off scheduled chats before signing out of their cloud principal.",
      );
    }
  }

  assertScheduledChatsCanClearAuthentication(input: Readonly<{
    identities: readonly Readonly<{
      apiUrl: string;
      userId: string;
      organizationId?: string;
    }>[];
    hasUnrecognizedValue: boolean;
  }>): void {
    if (
      this.#scheduledChatRecoveryInventoryIsCurrent()
      && this.#scheduledChatStore?.hasAuthorityBearingState() !== true
      && this.#orphanedScheduledChats.size === 0
    ) return;
    const bound = this.#store.vault()?.humanAuthority ?? null;
    if (
      bound === null
      || input.hasUnrecognizedValue
      || input.identities.some((identity) =>
        identity.userId === bound.userId
        && (
          identity.organizationId === undefined
          || identity.organizationId === bound.organizationId
        )
        && (
          bound.apiOrigin === null
          || identity.apiUrl === bound.apiOrigin
        )
      )
    ) {
      throw new SessionSyncCoordinatorError(
        "invalid_state",
        "Turn off scheduled chats before clearing their cloud credential.",
      );
    }
  }

  async withScheduledChatSignOutAuthority<Value>(
    operation: () => Promise<Value>,
  ): Promise<Value> {
    return await this.#withScheduledChatAuthorityTransition(async () => {
      this.assertScheduledChatsCanSignOut();
      return await operation();
    });
  }

  assertScheduledChatsCanAcceptAuthentication(input: Readonly<{
    apiUrl: string;
    userId: string;
    organizationId?: string;
  }>): void {
    if (
      this.#scheduledChatRecoveryInventoryIsCurrent()
      && this.#scheduledChatStore?.hasAuthorityBearingState() !== true
      && this.#orphanedScheduledChats.size === 0
    ) return;
    const bound = this.#store.vault()?.humanAuthority ?? null;
    if (
      bound === null
      || input.userId !== bound.userId
      || (
        input.organizationId !== undefined
        && input.organizationId !== bound.organizationId
      )
      || (
        bound.apiOrigin !== null
        && input.apiUrl !== bound.apiOrigin
      )
    ) {
      throw new SessionSyncCoordinatorError(
        "authority_mismatch",
        "Turn off scheduled chats before signing in as another cloud principal.",
      );
    }
  }

  async withScheduledChatAuthenticationAuthority<Value>(
    input: Readonly<{
      apiUrl: string;
      userId: string;
      organizationId?: string;
    }>,
    operation: () => Promise<Value>,
  ): Promise<Value> {
    return await this.#withScheduledChatAuthorityTransition(async () => {
      this.assertScheduledChatsCanAcceptAuthentication(input);
      return await operation();
    });
  }

  #assertScheduledChatsCanChangeMembership(
    revokedDeviceId?: SyncDeviceId,
  ): void {
    const scheduled = this.#scheduledChatStore;
    if (
      scheduled?.hasPendingMutation() === true
      || (revokedDeviceId !== undefined
        && scheduled?.hasActiveOriginDevice(revokedDeviceId) === true)
    ) {
      throw new SessionSyncCoordinatorError(
        "invalid_state",
        "Turn off the affected scheduled chats or wait for their pending change before changing membership.",
      );
    }
  }

  async configure(input: Readonly<{
    paneId: string;
    expectedRevision: number;
    prompt: string;
    rrule: string;
    timeZone: string;
    now: number;
  }>): Promise<void> {
    await this.#scheduledChatCommand(async (signal) => {
      const store = this.#requireScheduledChatStore();
      const now = scheduledChatEpochMsSchema.parse(input.now);
      const rrule = canonicalScheduledChatRRuleSchema.parse(input.rrule);
      const timeZone = scheduledChatTimeZoneSchema.parse(input.timeZone);
      const firstRunAt = nextScheduledChatOccurrence({
        rrule,
        timeZone,
        after: now,
      });
      if (firstRunAt === null) {
        throw new SessionSyncCoordinatorError(
          "invalid_state",
          "The requested schedule has no future occurrence.",
        );
      }
      const authority = await (async () => {
        try {
          return await this.#scheduledChatAuthority(input.paneId);
        } catch (error) {
          if (
            !(error instanceof SessionSyncCoordinatorError)
            || error.code !== "invalid_state"
          ) throw error;
          await this.#publisherCycle(signal);
          return await this.#scheduledChatAuthority(input.paneId);
        }
      })();
      const current = store.get(input.paneId);
      const highWater = store.generationHighWater(
        input.paneId,
        authority.binding.sessionId,
      );
      if (
        current !== null && current.sessionId !== authority.binding.sessionId
      ) {
        throw new SessionSyncCoordinatorError(
          "conflict",
          "This scheduled chat belongs to a different synced session.",
        );
      }
      const previousGeneration = highWater?.generation ?? "0";
      const generation = nextPositiveSyncUint64(previousGeneration);
      const header = scheduledChatDefinitionHeaderSchema.parse({
        protocol: SESSION_SYNC_PROTOCOL,
        payloadKind: "scheduled_chat_definition",
        payloadVersion: 1,
        ...authority.vault.vault,
        membershipEpoch: authority.vault.membershipEpoch,
        originDeviceId: authority.deviceId,
        sessionId: authority.binding.sessionId,
        mirrorEpoch: authority.head.mirrorEpoch,
        writerGeneration: authority.head.writerGeneration,
        bootId: authority.boot.bootId,
        bootGeneration: authority.boot.bootGeneration,
        keyEpoch: authority.vault.rootKeyEpoch,
        previousGeneration,
        generation,
        rrule,
        timeZone,
      });
      const definition = scheduledChatDefinitionSchema.parse({
        version: 1,
        sessionId: authority.binding.sessionId,
        generation,
        rrule,
        timeZone,
        prompt: input.prompt,
      });
      const rootKey = selectLocalSessionSyncRootKey({
        keyring: authority.keyring,
        expectedVault: authority.vault.vault,
        keyEpoch: authority.vault.rootKeyEpoch,
      });
      let sealed: Awaited<ReturnType<typeof sealScheduledChatDefinition>>;
      try {
        sealed = await sealScheduledChatDefinition({
          definition,
          header,
          rootKey,
        });
      } finally {
        rootKey.fill(0);
      }
      const request = putScheduledChatRequestSchema.parse({
        version: 1,
        operation: "put_scheduled_chat",
        definition: sealed,
      });
      const operationId = randomOpaque("syncop");
      const mutation = store.transaction(() => {
        this.#journal.prepare({
          operationId,
          kind: "put_scheduled_chat",
          sessionId: authority.binding.sessionId,
          request,
          now,
        });
        return store.preparePut({
          operationId,
          paneId: input.paneId,
          sessionId: authority.binding.sessionId,
          expectedPaneRevision: input.expectedRevision,
          targetGeneration: generation,
          request,
          definition: sealed,
          nextRunAt: firstRunAt,
          now,
        });
      });
      await this.#dispatchScheduledMutation(
        mutation,
        authority.proof,
        signal,
        false,
      );
    });
  }

  async remove(input: Readonly<{
    paneId: string;
    expectedRevision: number;
    now: number;
  }>): Promise<void> {
    const store = this.#requireScheduledChatStore();
    const now = scheduledChatEpochMsSchema.parse(input.now);
    const requested = store.requestDesiredOff({
      paneId: input.paneId,
      expectedPaneRevision: input.expectedRevision,
      now,
    });
    if (requested === null) return;
    await this.#scheduledChatCommand(async (signal) => {
      const desired = store.desiredOff(input.paneId);
      if (desired === null) return;
      await this.#clearDesiredOffIntent(desired, signal, false);
    }, { recoverDesiredOff: false });
  }

  async #scheduledChatCommand(
    operation: (signal: AbortSignal) => Promise<void>,
    options: Readonly<{ recoverDesiredOff?: boolean }> = {},
  ): Promise<void> {
    if (this.#admissionClosed) {
      throw new SessionSyncCoordinatorError(
        "operation_failed",
        "Session sync admission is closed.",
      );
    }
    this.#activeOperations += 1;
    try {
      await this.#withExclusive(async () => {
        const signal = this.#abort?.signal ?? new AbortController().signal;
        await this.#recoverRestartWork(signal, options);
        if (!this.#restartRecovered) {
          throw new SessionSyncCoordinatorError(
            "upstream_ambiguous",
            "A prior encrypted schedule change is still being recovered.",
            true,
          );
        }
        await operation(signal);
      });
    } catch (error) {
      if (error instanceof SessionSyncCoordinatorError) throw error;
      if (error instanceof ScheduledChatStoreError) {
        throw new SessionSyncCoordinatorError(
          error.code === "conflict" ? "conflict" : "invalid_state",
          error.message,
          error.code === "conflict",
        );
      }
      throw error;
    } finally {
      this.#activeOperations -= 1;
    }
  }

  async execute(
    command: RuntimeSessionSyncDomainCommand,
  ): Promise<SessionSyncCommandResult> {
    if (this.#admissionClosed) {
      throw new SessionSyncCoordinatorError(
        "operation_failed",
        "Session sync admission is closed.",
      );
    }
    this.#activeOperations += 1;
    try {
    let result: SessionSyncCommandResult | undefined;
    let failure: Error | undefined;
    const run = this.#commandTail.then(async () => {
      try {
        result = await this.#executeSerialized(command);
      } catch (error) {
        failure = error instanceof Error
          ? error
          : new SessionSyncCoordinatorError(
            "operation_failed",
            "The session sync operation failed with an invalid error value.",
          );
      }
    });
    this.#commandTail = run.catch(() => undefined);
    await run;
    if (failure !== undefined) throw failure;
    if (result === undefined) {
      throw new SessionSyncCoordinatorError(
        "operation_failed",
        "The session sync operation did not complete.",
      );
    }
    return result;
    } finally {
      this.#activeOperations -= 1;
    }
  }

  async authenticationChanged(): Promise<void> {
    if (this.#admissionClosed) return;
    this.#activeOperations += 1;
    try {
      await this.#withExclusive(async () => {
        await this.#observeScope();
        const signal = this.#abort?.signal ?? new AbortController().signal;
        await this.#recoverRestartWork(signal);
        await this.#discoverLocalOrphanedScheduledChats();
      });
      await this.#publishCurrentStatus();
    } finally {
      this.#activeOperations -= 1;
    }
  }

  async #executeSerialized(
    command: RuntimeSessionSyncDomainCommand,
  ): Promise<SessionSyncCommandResult> {
    const now = this.#now();
    const settings = this.#store.settings();
    if (command.type !== "sessionSync.retry" && command.expectedRevision !== settings.revision) {
      throw new SessionSyncCoordinatorError(
        "revision_conflict",
        "Session sync settings changed. Refresh and try again.",
        true,
      );
    }
    const vault = this.#store.vault();
    if (
      vault !== null
      && !sessionSyncHumanAuthorityMatches(vault.humanAuthority, this.#safeHumanScope())
    ) {
      throw new SessionSyncCoordinatorError(
        "authority_mismatch",
        "Session sync belongs to another signed-in human account and organization.",
      );
    }
    switch (command.type) {
      case "sessionSync.enable": {
        if (!this.#cloudConfigured) {
          throw new SessionSyncCoordinatorError(
            "capability_unavailable",
            "Cloud session sync is not configured.",
          );
        }
        const next = this.#store.setEnabled({
          expectedRevision: command.expectedRevision,
          enabled: true,
          deviceName: command.deviceName,
          now,
        });
        const custody = await this.#keyCustody.ensureDevice();
        this.#store.recordDeviceKeys({
          publicKeys: custody.publicKeys,
          credentialGeneration: this.#humanScope()?.credentialGeneration ?? 0,
          now,
        });
        await this.#publishCurrentStatus(next.revision);
        return { type: "accepted" };
      }
      case "sessionSync.disable":
        return await this.#withExclusive(async () => {
          this.assertScheduledChatsCanLoseSyncAuthority();
          const current = this.#store.settings();
          if (current.revision !== command.expectedRevision) {
            throw new SessionSyncCoordinatorError(
              "revision_conflict",
              "Session sync settings changed. Refresh and try again.",
              true,
            );
          }
          this.#store.setEnabled({
            expectedRevision: command.expectedRevision,
            enabled: false,
            now: this.#now(),
          });
          this.#scopeGeneration += 1;
          await this.#clearRemoteProjection();
          await this.#publishCurrentStatus();
          return { type: "accepted" };
        });
      case "sessionSync.retry":
        for (const worker of ["enrollment", "publisher", "observer", "heartbeat"] as const) {
          const retry = this.#store.retry(worker);
          if (retry !== null) {
            this.#store.clearRetry({ worker, expectedGeneration: retry.generation });
          }
        }
        await this.#publishCurrentStatus();
        return { type: "accepted" };
      case "sessionSync.scheduledChat.orphan.clear":
        await this.clearOrphanedScheduledChat({ orphanId: command.orphanId });
        return { type: "accepted" };
      case "sessionSync.recovery.reveal":
        return await this.#revealRecoveryKit();
      case "sessionSync.recoveryKitSavedOffline":
        if (
          this.#reveal === null
          || this.#reveal.id !== command.revealId
          || this.#reveal.expiresAt < now
        ) {
          throw new SessionSyncCoordinatorError(
            "invalid_state",
            "The recovery-key reveal expired. Reveal it again before confirming.",
          );
        }
        this.#recoveryAcknowledged = true;
        this.#clearReveal();
        await this.#publishCurrentStatus();
        return { type: "accepted" };
      case "sessionSync.enrollment.approve":
        this.#assertScheduledChatsCanChangeMembership();
        if (!runtimeSessionSyncCapabilities.enrollmentApproval) {
          throw new SessionSyncCoordinatorError(
            "capability_unavailable",
            "Device approval is not available in this build.",
          );
        }
        this.#approveEnrollment(command.requestId, command.pairingCode);
        return { type: "accepted" };
      case "sessionSync.device.revoke":
        this.#assertScheduledChatsCanChangeMembership(command.deviceId);
        if (!runtimeSessionSyncCapabilities.deviceRevocation) {
          throw new SessionSyncCoordinatorError(
            "capability_unavailable",
            "Device revocation is not available in this build.",
          );
        }
        this.#changeMembership({ kind: "revoke", deviceId: command.deviceId });
        return { type: "accepted" };
      case "sessionSync.recovery.rotate":
        this.#assertScheduledChatsCanChangeMembership();
        if (!runtimeSessionSyncCapabilities.recoveryRotation) {
          throw new SessionSyncCoordinatorError(
            "capability_unavailable",
            "Recovery rotation is not available in this build.",
          );
        }
        this.#changeMembership({ kind: "rotate_recovery" });
        return { type: "accepted" };
      case "sessionSync.recovery.import":
        this.assertScheduledChatsCanLoseSyncAuthority();
        if (!runtimeSessionSyncCapabilities.recoveryImport) {
          throw new SessionSyncCoordinatorError(
            "capability_unavailable",
            "Recovery import is not available in this build.",
          );
        }
        this.#importRecovery(command.recoveryKit);
        return { type: "accepted" };
      case "sessionSync.reset":
        this.assertScheduledChatsCanLoseSyncAuthority();
        if (!runtimeSessionSyncCapabilities.vaultReset) {
          throw new SessionSyncCoordinatorError(
            "capability_unavailable",
            "Vault reset is not available in this build.",
          );
        }
        this.#resetVault();
        return { type: "accepted" };
    }
  }

  async #workerLoop(worker: SessionSyncWorker, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.#runWorkerCycle(worker, signal);
      await abortableSleep(WORKER_POLL_MS, signal);
    }
  }

  async #runWorkerCycle(worker: SessionSyncWorker, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.#admissionClosed) return;
    const retry = this.#store.retry(worker);
    if (retry !== null && retry.notBefore > this.#now()) return;
    try {
      const scopeReady = await this.#observeScope();
      if (!scopeReady) {
        await this.#publishCurrentStatus();
        return;
      }
      if (!this.#store.settings().enabled && worker !== "observer") return;
      await this.#withExclusive(async () => {
        // A put, clear, or run acknowledgment can lose its response after the
        // startup recovery cut was marked complete. Re-open that cut from the
        // durable exact-replay journal so a live process heals itself before
        // inventory or due-run work can mint another operation.
        if (this.#hasPendingScheduledChatReplay()) {
          this.#restartRecovered = false;
        }
        if (!this.#restartRecovered) await this.#recoverRestartWork(signal);
        else await this.#reconcileScheduledChatRecoveryInventory(signal);
        if (!this.#restartRecovered) return;
        if (!this.#store.settings().enabled) return;
        switch (worker) {
          case "enrollment":
            await this.#enrollmentCycle(signal);
            break;
          case "publisher":
            await this.#publisherCycle(signal);
            break;
          case "observer":
            await this.#observerCycle(signal);
            break;
          case "heartbeat":
            await this.#heartbeatCycle(signal);
            break;
        }
      });
      if (retry !== null) {
        this.#store.clearRetry({ worker, expectedGeneration: retry.generation });
      }
    } catch (error) {
      if (signal.aborted) return;
      const current = this.#store.retry(worker);
      try {
        const retryAfterMs = remoteRetryAfter(error);
        this.#store.scheduleRetry({
          worker,
          expectedGeneration: current?.generation ?? null,
          errorCode: retryCode(error),
          now: this.#now(),
          random: this.#random,
          ...(retryAfterMs === undefined
            ? {}
            : { serverRetryAfterMs: retryAfterMs }),
        });
      } catch {
        // A concurrent explicit retry won the durable retry generation.
      }
      await this.#publishCurrentStatus(undefined, error).catch(() => undefined);
    }
  }

  async #withExclusive<Value>(operation: () => Promise<Value>): Promise<Value> {
    const predecessor = this.#exclusiveTail;
    let release!: () => void;
    this.#exclusiveTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    this.#activeExclusiveWork += 1;
    try {
      return await operation();
    } finally {
      this.#activeExclusiveWork -= 1;
      release();
    }
  }

  async #withScheduledChatAuthorityTransition<Value>(
    operation: () => Promise<Value>,
  ): Promise<Value> {
    if (this.#admissionClosed) {
      throw new SessionSyncCoordinatorError(
        "operation_failed",
        "Session sync admission is closed.",
      );
    }
    this.#activeOperations += 1;
    try {
      return await this.#withExclusive(operation);
    } finally {
      this.#activeOperations -= 1;
    }
  }

  #hasPendingScheduledChatReplay(): boolean {
    return this.#scheduledChatStore?.hasDesiredOffIntent() === true
      || this.#journal.listRestartWork().some(({ entry }) =>
        entry.kind === "put_scheduled_chat"
        || entry.kind === "clear_scheduled_chat"
        || entry.kind === "ack_scheduled_run"
      );
  }

  async #surfaceScheduledChatRecoveryDespiteJournal(
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.#reconcileScheduledChatRecoveryInventory(signal);
    } finally {
      await this.#discoverLocalOrphanedScheduledChats();
    }
  }

  #abandonPreparedScheduledChatOperation(
    entry: SessionSyncOperationJournalEntry,
  ): void {
    if (entry.state !== "prepared") {
      throw new SessionSyncStoreError(
        "corrupt_state",
        "Only an undispatched scheduled operation can be abandoned locally.",
      );
    }
    const now = Math.max(this.#now(), entry.updatedAt);
    if (
      entry.kind === "put_scheduled_chat"
      || entry.kind === "clear_scheduled_chat"
    ) {
      const schedules = this.#requireScheduledChatStore();
      const mutation = schedules.mutation(entry.operationId);
      if (
        mutation === null
        || mutation.state !== "prepared"
        || mutation.sessionId !== entry.scope.sessionId
        || mutation.requestDigest !== entry.requestDigest
        || canonicalSessionSyncJson(mutation.request)
          !== canonicalSessionSyncJson(entry.request)
        || (mutation.kind === "put") !== (entry.kind === "put_scheduled_chat")
      ) {
        throw new ScheduledChatStoreError(
          "corrupt_state",
          "The undispatched encrypted schedule operation lost its local mutation fence.",
        );
      }
      schedules.transaction(() => {
        schedules.discardPrepared(entry.operationId);
        this.#journal.settle({
          operationId: entry.operationId,
          outcome: {
            kind: "restart_abandoned_before_dispatch",
            operation: entry.kind,
          },
          now,
        });
      });
      return;
    }
    if (entry.kind !== "ack_scheduled_run") {
      throw new SessionSyncStoreError(
        "corrupt_state",
        "The undispatched recovery operation is not schedule-owned.",
      );
    }
    const request = acknowledgeScheduledChatRunRequestSchema.parse(entry.request);
    const run = this.#requireScheduledChatStore().run(request.runId);
    if (
      entry.scope.sessionId !== request.sessionId
      || run === null
      || run.sessionId !== request.sessionId
      || run.scheduleGeneration !== request.scheduleGeneration
      || run.occurrenceSequence !== request.occurrenceSequence
      || run.scheduledFor !== request.scheduledFor
    ) {
      throw new ScheduledChatStoreError(
        "corrupt_state",
        "The undispatched scheduled acknowledgment lost its local run fence.",
      );
    }
    this.#journal.settle({
      operationId: entry.operationId,
      outcome: {
        kind: "restart_abandoned_before_dispatch",
        operation: entry.kind,
      },
      now,
    });
  }

  async #recoverRestartWork(
    signal: AbortSignal,
    options: Readonly<{ recoverDesiredOff?: boolean }> = {},
  ): Promise<void> {
    signal.throwIfAborted();
    this.#restartRecovered = false;
    for (const { entry, disposition } of this.#journal.listRestartWork()) {
      if (
        entry.kind === "put_scheduled_chat"
        || entry.kind === "clear_scheduled_chat"
        || entry.kind === "ack_scheduled_run"
      ) {
        if (disposition === "dispatch_prepared") {
          this.#abandonPreparedScheduledChatOperation(entry);
          continue;
        }
        try {
          const recovered = await this.#recoverScheduledChatOperation(
            entry,
            signal,
          );
          if (!recovered) {
            await this.#surfaceScheduledChatRecoveryDespiteJournal(signal);
            if (this.#journal.get(entry.operationId)?.state === "terminal") {
              continue;
            }
            return;
          }
        } catch (error) {
          if (signal.aborted) throw error;
          if (this.#journal.get(entry.operationId)?.state !== "terminal") {
            await this.#surfaceScheduledChatRecoveryDespiteJournal(signal);
            if (this.#journal.get(entry.operationId)?.state === "terminal") {
              continue;
            }
            return;
          }
        }
        continue;
      }
      if (entry.kind === "publish_session") {
        try {
          const recovered = await this.#recoverSessionPublicationOperation(
            entry,
            signal,
          );
          if (!recovered) {
            await this.#surfaceScheduledChatRecoveryDespiteJournal(signal);
            return;
          }
        } catch (error) {
          if (signal.aborted) throw error;
          if (this.#journal.get(entry.operationId)?.state !== "terminal") {
            await this.#surfaceScheduledChatRecoveryDespiteJournal(signal);
            return;
          }
        }
        continue;
      }
      if (
        disposition !== "reconcile_only"
        && entry.replayPolicy === "exact_replay"
      ) {
        // Exact replays retain their original operation ID and durable request.
        // They remain fenced until an explicitly authorized dispatcher resumes
        // them; workers must not mint a replacement operation around the fence.
        return;
      }
      const now = Math.max(this.#now(), entry.updatedAt);
      switch (entry.kind) {
        case "establish_boot":
        case "heartbeat":
          this.#store.fenceBootForRestart(now);
          break;
        case "begin_snapshot":
          this.#store.fenceObserverForRestart(now);
          break;
        case "reserve_session":
        case "acquire_writer":
        case "delete_session":
          if (entry.scope.sessionId !== null) {
            this.#store.markHeadConflict(entry.scope.sessionId, now);
          }
          break;
        case "admit_membership_proposal":
        case "submit_enrollment":
        case "claim_enrollment":
        case "clear_orphaned_scheduled_chat":
          break;
        case "update_membership":
        case "approve_enrollment":
        case "bootstrap_vault":
        case "recover_vault":
          return;
      }
      this.#journal.settle({
        operationId: entry.operationId,
        outcome: {
          kind: disposition === "dispatch_prepared"
            ? "restart_abandoned_before_dispatch"
            : "restart_fenced_for_reconciliation",
          operation: entry.kind,
          priorState: entry.state,
        },
        now,
      });
    }
    if (
      await this.#keyCustody.pendingVaultRootTransitionMetadata() !== null
      || await this.#recoveryCustody.pendingTransitionMetadata() !== null
    ) return;
    const recoverDesiredOff = options.recoverDesiredOff ?? true;
    if (this.#scheduledChatStore?.hasDesiredOffIntent() !== true) {
      await this.#reconcileScheduledChatRecoveryInventory(signal);
    }
    if (this.#scheduledChatStore !== null) {
      let priorAuthority: SessionSyncProofAuthority | null;
      try {
        priorAuthority = await this.#authority();
      } catch (error) {
        await this.#discoverLocalOrphanedScheduledChats();
        if (this.#orphanedScheduledChats.size > 0) {
          this.#restartRecovered = true;
          return;
        }
        throw error;
      }
      if (priorAuthority === null) {
        await this.#discoverLocalOrphanedScheduledChats();
        if (this.#orphanedScheduledChats.size > 0) {
          this.#restartRecovered = true;
        }
        return;
      }
      const membership = accepted(await this.#client.execute({
        version: 1,
        operation: "read_membership",
      }, priorAuthority, signal));
      if (membership.kind !== "membership") {
        throw new SessionSyncRemoteFailure("LOCAL_UNKNOWN");
      }
      await this.#acceptMembership(membership, priorAuthority, signal);
      this.#membershipResponse = membership;
      const currentAuthority = await this.#authority();
      if (currentAuthority === null) return;
      if (this.#scheduledChatStore.hasDesiredOffIntent()) {
        if (recoverDesiredOff) {
          await this.#recoverDesiredOffIntents(signal);
          if (this.#scheduledChatStore.hasDesiredOffIntent()) return;
        } else {
          this.#restartRecovered = true;
          return;
        }
      }
      await this.#reconcileScheduledChatRecoveryInventory(signal);
      await this.#reconcileScheduledChatInventory(currentAuthority, signal);
    }
    this.#restartRecovered = true;
  }

  async #observeScope(): Promise<boolean> {
    if (!this.#cloudConfigured) return false;
    let scope: SessionSyncHumanScope | null;
    try {
      scope = this.#humanScope();
    } catch {
      return false;
    }
    const humanAuthority = humanAuthorityFromScope(scope);
    const fingerprint = humanAuthority !== null
      ? canonicalSessionSyncJson({
          credentialGeneration: scope!.credentialGeneration,
          ...humanAuthority,
        })
      : null;
    if (fingerprint !== this.#lastScopeFingerprint) {
      this.#clearReveal();
      this.#store.clearRemoteForScopeChange(this.#now());
      this.#scopeGeneration += 1;
      this.#membershipResponse = null;
      this.#pendingEnrollments = [];
      this.#localPaneBindingAdmission = null;
      this.#scheduledChatRecoveryInventoryScope = null;
      this.#orphanedScheduledChats.clear();
      this.#lastScopeFingerprint = fingerprint;
      await this.#clearRemoteProjection();
    }
    const vault = this.#store.vault();
    return fingerprint !== null
      && (
        vault === null
        || sessionSyncHumanAuthorityMatches(vault.humanAuthority, scope)
        || legacySessionSyncHumanAuthorityMatches(vault.humanAuthority, scope)
      );
  }

  #safeHumanScope(): SessionSyncHumanScope | null {
    try {
      return this.#humanScope();
    } catch {
      return null;
    }
  }

  #scheduledChatRecoveryInventoryRequired(): boolean {
    return this.#scheduledChatStore !== null
      && this.#cloudConfigured
      && this.#store.vault()?.state === "active";
  }

  #scheduledChatRecoveryInventoryTargetScope(): string | null {
    if (!this.#scheduledChatRecoveryInventoryRequired()) return null;
    const vault = this.#store.vault();
    const deviceId = this.#store.device()?.deviceId ?? null;
    const scope = this.#safeHumanScope();
    if (
      vault?.state !== "active"
      || deviceId === null
      || !sessionSyncHumanAuthorityMatches(vault.humanAuthority, scope)
    ) return null;
    return canonicalSessionSyncJson({
      credentialGeneration: scope!.credentialGeneration,
      humanAuthority: vault.humanAuthority,
      originDeviceId: deviceId,
      vault: vault.vault,
    });
  }

  #scheduledChatRecoveryInventoryIsCurrent(): boolean {
    if (!this.#scheduledChatRecoveryInventoryRequired()) return true;
    const target = this.#scheduledChatRecoveryInventoryTargetScope();
    return target !== null
      && target === this.#scheduledChatRecoveryInventoryScope;
  }

  #requireCurrentHumanAuthority(): SessionSyncHumanAuthority {
    const authority = humanAuthorityFromScope(this.#safeHumanScope());
    if (authority === null) {
      throw new SessionSyncCoordinatorError(
        "authority_mismatch",
        "Select the original signed-in account and organization before using session sync.",
      );
    }
    return authority;
  }

  async #enrollmentCycle(signal: AbortSignal): Promise<void> {
    const device = this.#store.device();
    if (device?.enrollmentState === "active") return;
    await this.#bootstrapVault(signal);
  }

  async #bootstrapVault(signal: AbortSignal): Promise<void> {
    const settings = this.#store.settings();
    if (!settings.enabled) return;
    const humanAuthority = this.#requireCurrentHumanAuthority();
    const metadata = await this.#keyCustody.ensureDevice();
    let device = this.#store.recordDeviceKeys({
      publicKeys: metadata.publicKeys,
      credentialGeneration: this.#humanScope()?.credentialGeneration ?? 0,
      now: this.#now(),
    });
    let request: BootstrapSyncVaultRequest;
    let deviceId: SyncDeviceId;
    if (
      device.enrollmentState === "pending"
      && typeof device.pendingEnrollment === "object"
      && device.pendingEnrollment !== null
      && "kind" in device.pendingEnrollment
      && device.pendingEnrollment.kind === "bootstrap"
      && "request" in device.pendingEnrollment
    ) {
      if (
        !("humanAuthority" in device.pendingEnrollment)
        || canonicalSessionSyncJson(device.pendingEnrollment.humanAuthority)
          !== canonicalSessionSyncJson(humanAuthority)
      ) {
        throw new SessionSyncCoordinatorError(
          "authority_mismatch",
          "The pending vault enrollment belongs to another human scope.",
        );
      }
      request = device.pendingEnrollment.request as BootstrapSyncVaultRequest;
      request = (await import("@hraness/agent-tasks-protocol")).bootstrapSyncVaultRequestSchema.parse(request);
      deviceId = request.membershipHead.statement.members[0]!.deviceId;
    } else {
      const built = await this.#buildBootstrapRequest(settings.deviceName, metadata.publicKeys);
      request = built.request;
      deviceId = built.deviceId;
      device = this.#store.recordEnrollmentState({
        expectedRevision: device.revision,
        state: "pending",
        deviceId,
        pendingEnrollment: { kind: "bootstrap", humanAuthority, request },
        now: this.#now(),
      });
    }
    const runtime = await this.#keyCustody.loadRuntime(metadata.publicKeys);
    accepted(await this.#client.negotiate(signal));
    const response = await this.#journaledHumanMutation(
      "bootstrap_vault",
      request,
      async () => await this.#client.bootstrap(request, {
        membership: request.membershipHead.statement,
        deviceId,
        keys: runtime,
      }, signal),
    );
    if (response.kind !== "vault_created") {
      throw new SessionSyncRemoteFailure("LOCAL_UNKNOWN");
    }
    const wrap = request.wrappedRoot;
    this.#store.replaceVault({
      expectedRevision: null,
      head: request.membershipHead,
      wrappedRoot: wrap,
      wrappedRoots: [wrap],
      humanAuthority,
      now: this.#now(),
    });
    this.#store.recordEnrollmentState({
      expectedRevision: device.revision,
      state: "active",
      deviceId,
      now: this.#now(),
    });
    await this.#publishCurrentStatus();
  }

  async #buildBootstrapRequest(
    deviceName: string,
    publicKeys: Awaited<ReturnType<SessionSyncKeyCustody["ensureDevice"]>>["publicKeys"],
  ): Promise<Readonly<{ request: BootstrapSyncVaultRequest; deviceId: SyncDeviceId }>> {
    const now = this.#now();
    const deviceId = syncDeviceIdSchema.parse(randomOpaque("syncdevice"));
    const vault = syncVaultCoordinateSchema.parse({
      tenantId: randomOpaque("synctenant"),
      organizationId: randomOpaque("syncorg"),
      ownerUserId: randomOpaque("syncuser"),
      vaultId: randomOpaque("syncvault"),
      vaultGeneration: "1",
    });
    const rootKey = createSyncVaultRootKey();
    try {
      const generatedRecovery = await generateSyncRecoveryKit(
        vault,
        "1",
        "1",
        rootKey,
      );
      const rootKeyCommitment = await commitSyncVaultRootKey(rootKey);
      const wrappedRoot = await wrapSyncVaultRootKey(
        rootKey,
        syncVaultRootWrapContextSchema.parse({
          version: 1,
          ...vault,
          membershipEpoch: "1",
          rootKeyEpoch: "1",
          recipientDeviceId: deviceId,
          recipientAgreementKeyId: publicKeys.agreement.keyId,
        }),
        publicKeys.agreement.publicKey,
      );
      const recoveryRootWrap = await wrapSyncVaultRootKeyForRecovery(
        rootKey,
        syncRecoveryVaultRootWrapContextSchema.parse({
          version: 1,
          vault,
          membershipEpoch: "1",
          recoveryGeneration: "1",
          rootKeyEpoch: "1",
          rootKeyCommitment,
          recipientRecoveryAgreementKeyId:
            generatedRecovery.authority.agreementKeyId,
        }),
        generatedRecovery.authority,
      );
      const statement = syncMembershipStatementSchema.parse({
        version: 1,
        ...vault,
        membershipEpoch: "1",
        previousMembershipDigest: null,
        recoveryGeneration: "1",
        enrollmentPairingDigest: null,
        rootKeyEpoch: "1",
        rootKeyCommitment,
        rootWrapManifestDigest: await digestSyncVaultRootWrapManifest([
          wrappedRoot,
        ]),
        rootKeyLinkDigest: null,
        recoveryRootWrapDigest: await digestSyncRecoveryVaultRootWrap(
          recoveryRootWrap,
        ),
        members: [{
          deviceId,
          name: deviceName,
          status: "active",
          keys: publicKeys,
          approvedAt: nowUint64(now),
        }],
      });
      const runtime = await this.#keyCustody.loadRuntime(publicKeys);
      const head = syncMembershipHeadSchema.parse({
        statement,
        statementDigest: await digestSyncMembershipStatement(statement),
        signatures: [await signSyncMembershipStatement(
          statement,
          deviceId,
          publicKeys.signing.keyId,
          runtime.signingPrivateKey,
        )],
      });
      await this.#keyCustody.installVaultRootKeyring({
        expectedPublicKeys: publicKeys,
        expectedVaultRootKeyring: null,
        vault,
        membershipEpoch: positiveSyncUint64Schema.parse("1"),
        currentRootKeyEpoch: positiveSyncUint64Schema.parse("1"),
        rootKeys: [{ keyEpoch: positiveSyncUint64Schema.parse("1"), rootKey }],
      });
      await this.#recoveryCustody.installInitial(generatedRecovery.recoveryKit);
      return {
        deviceId,
        request: { version: 1, membershipHead: head, wrappedRoot, recoveryAuthority: generatedRecovery.authority, recoveryRootWrap },
      };
    } finally {
      rootKey.fill(0);
    }
  }

  async #heartbeatCycle(signal: AbortSignal): Promise<void> {
    const authority = await this.#authority();
    if (authority === null) return;
    let boot = this.#store.boot();
    if (boot === null) {
      boot = this.#store.beginBoot({
        bootId: syncBootIdSchema.parse(randomOpaque("syncboot")),
        now: this.#now(),
      });
    }
    if (!boot.acknowledged) {
      const request: SessionSyncBackendRequest = {
        version: 1,
        operation: "establish_boot",
        bootId: boot.bootId,
        ...(boot.bootGeneration === null
          ? {}
          : { bootGeneration: boot.bootGeneration }),
        heartbeatSequence: boot.heartbeatSequence,
      };
      const response = await this.#journaledWireMutation(
        request,
        authority,
        signal,
      );
      if (response.kind !== "boot_current") {
        throw new SessionSyncRemoteFailure("LOCAL_UNKNOWN");
      }
      if (!this.#store.acknowledgeBoot({
        bootId: response.bootId,
        bootGeneration: response.bootGeneration,
        heartbeatSequence: response.heartbeatSequence,
        now: this.#now(),
      })) throw new SessionSyncStoreError("stale", "Session sync boot changed.");
      return;
    }
    if (this.#now() - boot.updatedAt < HEARTBEAT_INTERVAL_MS) return;
    boot = this.#store.nextHeartbeat({
      bootId: boot.bootId,
      bootGeneration: boot.bootGeneration!,
      now: this.#now(),
    });
    const request: SessionSyncBackendRequest = {
      version: 1,
      operation: "heartbeat",
      bootId: boot.bootId,
      bootGeneration: boot.bootGeneration!,
      heartbeatSequence: boot.heartbeatSequence,
    };
    const response = await this.#journaledWireMutation(
      request,
      authority,
      signal,
    );
    if (
      response.kind !== "boot_current"
      || !this.#store.acknowledgeBoot({
        bootId: response.bootId,
        bootGeneration: response.bootGeneration,
        heartbeatSequence: response.heartbeatSequence,
        now: this.#now(),
      })
    ) throw new SessionSyncStoreError("stale", "Session sync heartbeat changed.");
  }

  async #publisherCycle(signal: AbortSignal): Promise<void> {
    const authority = await this.#authority();
    if (authority === null) return;
    const vault = this.#store.vault();
    const device = this.#store.device();
    const boot = this.#store.boot();
    if (
      vault?.state !== "active"
      || device?.enrollmentState !== "active"
      || device.deviceId === null
      || boot?.acknowledged !== true
      || boot.bootGeneration === null
    ) return;
    const runtime = await this.#keyCustody.loadRuntime(device.publicKeys);
    if (runtime.vaultRootKeyring === null) return;
    this.#localPaneBindingAdmission = this.#store.bindEligibleLocalPanes({
      vault: vault.vault,
      deviceId: device.deviceId,
      now: this.#now(),
    });
    await this.#publishLocalGrid();
    await this.#publishCurrentStatus();
    const localKeyring = runtimeKeyring(runtime.vaultRootKeyring);
    for (const dirty of this.#store.listDirtyLocalIntents()) {
      const { paneId, barrier, ...intent } = dirty;
      const nonce = this.#store.allocateLocalIntentNonce({
        sessionId: dirty.sessionId,
        keyEpoch: runtime.vaultRootKeyring.currentRootKeyEpoch,
      });
      const rootKey = selectLocalSessionSyncRootKey({
        keyring: localKeyring,
        expectedVault: vault.vault,
        keyEpoch: runtime.vaultRootKeyring.currentRootKeyEpoch,
      });
      try {
        const sealed = await sealLocalSessionSyncIntent({
          intent,
          vault: vault.vault,
          keyEpoch: runtime.vaultRootKeyring.currentRootKeyEpoch,
          rootKey,
          nonce,
        });
        this.#store.storeSealedLocalIntent({
          paneId,
          expectedSourceRevision: Number(decodeSyncUint64(dirty.sourceRevision)),
          barrier,
          sealed,
          now: this.#now(),
        });
      } finally {
        rootKey.fill(0);
      }
    }
    for (const intent of this.#store.outbox()) {
      await this.#publishSession(intent.sessionId, vault, device.deviceId, boot, localKeyring, authority, signal);
    }
  }

  async #publishSession(
    sessionId: Parameters<SessionSyncStore["publicationWork"]>[0],
    vault: SessionSyncVaultState,
    deviceId: SyncDeviceId,
    boot: NonNullable<ReturnType<SessionSyncStore["boot"]>>,
    keyring: LocalSessionSyncRootKeyring,
    authority: SessionSyncProofAuthority,
    signal: AbortSignal,
  ): Promise<void> {
    let head = this.#store.localHead(sessionId);
    const pane = this.#store.outbox().find((candidate) => candidate.sessionId === sessionId);
    if (pane === undefined) return;
    const storedBinding = this.#store.paneBindingForSession(sessionId);
    let creationGrantDigest = storedBinding?.creationGrantDigest ?? null;
    let directoryOrdinal = head?.directoryOrdinal ?? null;
    if (directoryOrdinal === null) {
      creationGrantDigest = creationGrantDigest ?? await digestSyncRequestBody({
        protocol: SESSION_SYNC_PROTOCOL,
        purpose: "session_creation_grant",
        vault: vault.vault,
        sessionId,
        deviceId,
      });
      const reservation = await this.#journaledWireMutation({
        version: 1,
        operation: "reserve_session",
        sessionId,
        creationGrantDigest,
      }, authority, signal);
      if (reservation.kind !== "session_reserved") {
        throw new SessionSyncRemoteFailure("LOCAL_UNKNOWN");
      }
      directoryOrdinal = reservation.directoryOrdinal;
      if (storedBinding !== null) {
        this.#store.recordSessionReservation({
          paneId: storedBinding.paneId,
          expectedSessionId: sessionId,
          creationGrantDigest,
          now: this.#now(),
        });
      }
    }
    const replayingAttempt = this.#store.attempt(sessionId) !== null;
    if (
      head === null
      || head.writerGeneration === "0"
      || (head.syncState === "conflict" && !replayingAttempt)
    ) {
      const acquired = await this.#journaledWireMutation({
        version: 1,
        operation: "acquire_writer",
        sessionId,
        bootId: boot.bootId,
        bootGeneration: boot.bootGeneration!,
        acknowledgedMirrorEpoch: head?.mirrorEpoch
          ?? positiveSyncUint64Schema.parse("1"),
        acknowledgedSequence: head?.acknowledgedSequence
          ?? syncUint64Schema.parse("0"),
        acknowledgedDigest: head?.acknowledgedDigest ?? null,
      }, authority, signal);
      if (acquired.kind === "reconcile_required") {
        this.#store.markHeadConflict(sessionId, this.#now());
        return;
      }
      if (acquired.kind !== "writer_acquired") {
        throw new SessionSyncRemoteFailure("LOCAL_UNKNOWN");
      }
      head = this.#store.upsertLocalHead({
        sessionId,
        directoryOrdinal,
        mirrorEpoch: acquired.mirrorEpoch,
        writerGeneration: acquired.writerGeneration,
        bootId: acquired.bootId,
        bootGeneration: acquired.bootGeneration,
        membershipEpoch: vault.membershipEpoch,
        keyEpoch: vault.rootKeyEpoch,
        acknowledgedSequence: head?.acknowledgedSequence
          ?? syncUint64Schema.parse("0"),
        acknowledgedDigest: head?.acknowledgedDigest ?? null,
        acknowledgedSourceRevision: head?.acknowledgedSourceRevision ?? 0,
        now: this.#now(),
      });
    }
    let work = this.#store.publicationWork(sessionId);
    if (work === null) return;
    if (work.kind === "prepare") {
      const localIntent = await openLocalSessionSyncIntentFromKeyring({
        envelope: work.prepared.intent.sealed,
        expectedVault: vault.vault,
        keyring,
      });
      const contentRoot = selectLocalSessionSyncRootKey({
        keyring,
        expectedVault: vault.vault,
        keyEpoch: work.prepared.head.keyEpoch,
      });
      try {
        const contentKey = await deriveSessionContentKey(contentRoot, {
          version: 1,
          ...vault.vault,
          sessionId,
          keyEpoch: work.prepared.head.keyEpoch,
          originDeviceId: deviceId,
          mirrorEpoch: work.prepared.head.mirrorEpoch,
          writerGeneration: positiveSyncUint64Schema.parse(work.prepared.head.writerGeneration),
        }, ["encrypt"]);
        const header = sessionSyncHeaderSchema.parse({
          protocol: SESSION_SYNC_PROTOCOL,
          payloadVersion: 1,
          payloadKind: "session_summary",
          ...vault.vault,
          membershipEpoch: vault.membershipEpoch,
          originDeviceId: deviceId,
          sessionId,
          mirrorEpoch: work.prepared.head.mirrorEpoch,
          writerGeneration: work.prepared.head.writerGeneration,
          bootId: boot.bootId,
          bootGeneration: boot.bootGeneration,
          directoryOrdinal,
          keyEpoch: work.prepared.head.keyEpoch,
          syncSequence: work.prepared.nonce.sequence,
          sourceRevision: localIntent.sourceRevision,
          eventKind: localIntent.eventKind,
          previousDigest: work.prepared.head.acknowledgedDigest,
          ...(localIntent.eventKind === "created" && creationGrantDigest !== null
            ? { creationGrantDigest }
            : {}),
        });
        const envelope = await sealSessionSummary(
          sessionSummarySchema.parse({
            version: 1,
            sessionId,
            ownerDeviceId: deviceId,
            directoryOrdinal,
            sourceRevision: localIntent.sourceRevision,
            title: localIntent.title,
            ...(localIntent.repositoryDisplayName === undefined
              ? {}
              : { repositoryDisplayName: localIntent.repositoryDisplayName }),
            state: localIntent.state,
            deleted: localIntent.deleted,
          }),
          header,
          contentKey,
          work.prepared.nonce,
        );
        this.#store.recordAttempt({
          expected: work.prepared,
          envelope,
          now: this.#now(),
        });
      } finally {
        contentRoot.fill(0);
      }
      work = this.#store.publicationWork(sessionId);
    }
    if (work?.kind !== "replay") return;
    const response = await this.#journaledWireMutation({
      version: 1,
      operation: "publish_session",
      envelope: work.attempt.envelope,
    }, authority, signal);
    if (response.kind !== "session_accepted") {
      throw new SessionSyncRemoteFailure("LOCAL_UNKNOWN");
    }
    this.#store.settleAccepted({ accepted: response.accepted, now: this.#now() });
  }

  async #observerCycle(signal: AbortSignal): Promise<void> {
    const authority = await this.#authority();
    if (authority === null) return;
    const membership = accepted(await this.#client.execute({
      version: 1,
      operation: "read_membership",
    }, authority, signal));
    if (membership.kind !== "membership") {
      throw new SessionSyncRemoteFailure("LOCAL_UNKNOWN");
    }
    await this.#acceptMembership(membership, authority, signal);
    this.#membershipResponse = membership;
    const enrollments = accepted(await this.#client.execute({
      version: 1,
      operation: "list_enrollment_requests",
    }, authority, signal));
    if (enrollments.kind !== "enrollment_requests") {
      throw new SessionSyncRemoteFailure("LOCAL_UNKNOWN");
    }
    this.#pendingEnrollments = [...enrollments.requests];
    await this.#observeDirectory(authority, signal);
    await this.#projectRemoteSessions();
    await this.#scheduledChatCycle(authority, signal);
    if (this.#orphanedScheduledChats.size === 0) {
      await this.#resumeScheduledOccurrences?.();
    }
    await this.#publishCurrentStatus();
  }

  async #scheduledChatCycle(
    authority: SessionSyncProofAuthority,
    signal: AbortSignal,
  ): Promise<void> {
    const scheduledStore = this.#scheduledChatStore;
    const enqueue = this.#enqueueScheduledOccurrence;
    if (scheduledStore === null || enqueue === null) return;
    scheduledStore.purgeTerminalRuns(this.#now());
    await this.#reconcileScheduledChatInventory(authority, signal);
    if (this.#orphanedScheduledChats.size > 0) return;
    const boot = this.#store.boot();
    if (boot?.acknowledged !== true || boot.bootGeneration === null) return;
    for (let pageIndex = 0; pageIndex < MAX_SCHEDULED_CHAT_PAGES_PER_CYCLE; pageIndex += 1) {
      signal.throwIfAborted();
      const page = accepted(await this.#client.execute({
        version: 1,
        operation: "scheduled_run_page",
        bootId: boot.bootId,
        bootGeneration: boot.bootGeneration,
        pageSize: SCHEDULED_CHAT_RUN_PAGE_SIZE,
      }, authority, signal));
      if (page.kind !== "scheduled_run_page") {
        throw new SessionSyncRemoteFailure("LOCAL_UNKNOWN");
      }
      if (page.hasMore && page.runs.length === 0) {
        throw new SessionSyncRemoteFailure("LOCAL_UNKNOWN");
      }
      for (const run of page.runs) {
        await this.#executeScheduledRun(run, authority, signal);
      }
      if (!page.hasMore) return;
    }
  }

  async #discoverLocalOrphanedScheduledChats(): Promise<void> {
    const schedules = this.#scheduledChatStore;
    if (schedules === null) return;
    try {
      if (await this.#authority() !== null) return;
    } catch {
      // Human-authorized recovery remains available when device custody is absent.
    }
    const vault = this.#store.vault();
    if (
      vault?.state !== "active"
      || !sessionSyncHumanAuthorityMatches(vault.humanAuthority, this.#safeHumanScope())
    ) return;
    const next = new Map(this.#orphanedScheduledChats);
    for (const schedule of schedules.activeSchedules()) {
      const binding = this.#store.paneBindingForSession(schedule.sessionId);
      const originDeviceId = binding?.originDeviceId;
      if (originDeviceId === undefined) continue;
      if (
        schedules.mutationForPane(schedule.paneId) !== null
        && [...next.values()].some((value) =>
          value.paneId === schedule.paneId
          && value.sessionId === schedule.sessionId
          && value.originDeviceId === originDeviceId
        )
      ) continue;
      const retained = [...next.entries()].find(([, value]) =>
        value.sessionId === schedule.sessionId
        && value.paneId === schedule.paneId
        && value.originDeviceId === originDeviceId
        && value.generation === schedule.generation
        && value.ciphertextDigest === schedule.definitionCiphertextDigest
      );
      const orphanId = retained?.[0]
        ?? sessionSyncScheduledChatOrphanIdSchema.parse(
          randomOpaque("syncscheduleorphan"),
        );
      next.set(orphanId, {
        sessionId: schedule.sessionId,
        paneId: schedule.paneId,
        originDeviceId,
        generation: schedule.generation,
        ciphertextDigest: schedule.definitionCiphertextDigest,
      });
    }
    if (
      canonicalSessionSyncJson([...next])
      !== canonicalSessionSyncJson([...this.#orphanedScheduledChats])
    ) {
      this.#orphanedScheduledChats = next;
      await this.#publishCurrentStatus();
    }
  }

  #settlePendingScheduledMutationThroughHumanClear(
    schedules: ScheduledChatStore,
    paneId: string,
    evidence: Readonly<{
      sessionId: SessionPublicId;
      originDeviceId: SyncDeviceId;
      generation: PositiveSyncUint64;
      ciphertextDigest: SyncSha256Digest;
    }>,
    evidenceKind: "explicit_human_clear" | "human_recovery_inventory",
    nowValue: number,
  ): boolean {
    const mutation = schedules.mutationForPane(paneId);
    if (mutation === null) return false;
    const journal = this.#journal.get(mutation.operationId);
    const expectedKind = mutation.kind === "put"
      ? "put_scheduled_chat"
      : "clear_scheduled_chat";
    if (
      mutation.state !== "effect_started"
      || journal === null
      || journal.kind !== expectedKind
      || journal.scope.sessionId !== mutation.sessionId
      || journal.requestDigest !== mutation.requestDigest
      || canonicalSessionSyncJson(journal.request)
        !== canonicalSessionSyncJson(mutation.request)
      || (journal.state !== "dispatched" && journal.state !== "ambiguous")
    ) {
      throw new ScheduledChatStoreError(
        "corrupt_state",
        "The human-authorized schedule clear lost its exact local operation fence.",
      );
    }
    if (mutation.kind === "put") {
      const request = putScheduledChatRequestSchema.parse(mutation.request);
      if (
        request.definition.header.sessionId !== evidence.sessionId
        || request.definition.header.originDeviceId !== evidence.originDeviceId
        || request.definition.header.generation !== evidence.generation
        || request.definition.ciphertextDigest !== evidence.ciphertextDigest
      ) {
        throw new ScheduledChatStoreError(
          "conflict",
          "The human-authorized clear does not match the pending encrypted schedule put.",
        );
      }
    } else {
      const request = clearScheduledChatRequestSchema.parse(mutation.request);
      const active = schedules.get(paneId);
      if (
        request.sessionId !== evidence.sessionId
        || request.originDeviceId !== evidence.originDeviceId
        || request.expectedGeneration !== evidence.generation
        || active?.definitionCiphertextDigest !== evidence.ciphertextDigest
      ) {
        throw new ScheduledChatStoreError(
          "conflict",
          "The human-authorized clear does not match the pending encrypted schedule removal.",
        );
      }
    }
    const now = Math.max(nowValue, journal.updatedAt, mutation.updatedAt);
    schedules.settleMutationThroughHumanClearInTransaction({
      operationId: mutation.operationId,
      expectedSessionId: evidence.sessionId,
      expectedGeneration: evidence.generation,
      expectedCiphertextDigest: evidence.ciphertextDigest,
      now,
    });
    this.#journal.settle({
      operationId: mutation.operationId,
      outcome: {
        kind: "superseded_by_human_authorized_schedule_clear",
        evidence: evidenceKind,
        sessionId: evidence.sessionId,
        generation: evidence.generation,
        ciphertextDigest: evidence.ciphertextDigest,
      },
      now,
    });
    return true;
  }

  #settlePendingScheduledRunAcknowledgmentsThroughHumanClear(
    schedules: ScheduledChatStore,
    paneId: string,
    evidence: Readonly<{
      sessionId: SessionPublicId;
      generation: PositiveSyncUint64;
      ciphertextDigest: SyncSha256Digest;
    }>,
    evidenceKind: "explicit_human_clear" | "human_recovery_inventory",
    nowValue: number,
  ): void {
    for (const entry of this.#journal.listRecoverable()) {
      if (entry.kind !== "ack_scheduled_run") continue;
      const request = acknowledgeScheduledChatRunRequestSchema.parse(
        entry.request,
      );
      if (
        request.sessionId !== evidence.sessionId
        || BigInt(request.scheduleGeneration) > BigInt(evidence.generation)
      ) continue;
      const run = schedules.run(request.runId);
      if (
        entry.scope.sessionId !== request.sessionId
        || canonicalSessionSyncJson(entry.request)
          !== canonicalSessionSyncJson(request)
        || run === null
        || run.paneId !== paneId
        || run.sessionId !== request.sessionId
        || run.scheduleGeneration !== request.scheduleGeneration
        || run.occurrenceSequence !== request.occurrenceSequence
        || run.scheduledFor !== request.scheduledFor
      ) {
        throw new ScheduledChatStoreError(
          "corrupt_state",
          "The human-authorized schedule clear found an invalid run acknowledgment fence.",
        );
      }
      const now = Math.max(nowValue, entry.updatedAt, run.enqueuedAt);
      schedules.settleRunAcknowledgmentThroughHumanClearInTransaction({
        runId: request.runId,
        expectedPaneId: paneId,
        expectedSessionId: request.sessionId,
        expectedScheduleGeneration: request.scheduleGeneration,
        expectedOccurrenceSequence: request.occurrenceSequence,
        expectedScheduledFor: request.scheduledFor,
        now,
      });
      this.#journal.settle({
        operationId: entry.operationId,
        outcome: {
          kind: "superseded_by_human_authorized_schedule_clear",
          evidence: evidenceKind,
          runId: request.runId,
          sessionId: request.sessionId,
          generation: request.scheduleGeneration,
          clearedThroughGeneration: evidence.generation,
          ciphertextDigest: evidence.ciphertextDigest,
        },
        now,
      });
    }
  }

  async #reconcileScheduledChatRecoveryInventory(
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#scheduledChatRecoveryInventoryIsCurrent()) return;
    const targetScope = this.#scheduledChatRecoveryInventoryTargetScope();
    const schedules = this.#scheduledChatStore;
    const vaultState = this.#store.vault();
    const originDeviceId = this.#store.device()?.deviceId ?? null;
    if (
      targetScope === null
      || schedules === null
      || vaultState?.state !== "active"
      || originDeviceId === null
    ) return;
    const entries = new Map<SessionPublicId, Readonly<{
      state: "active" | "cleared";
      sessionId: SessionPublicId;
      originDeviceId: SyncDeviceId;
      generation: PositiveSyncUint64;
      ciphertextDigest: SyncSha256Digest;
    }>>();
    let afterSessionId: SessionPublicId | undefined;
    for (
      let pageIndex = 0;
      pageIndex < MAX_SCHEDULED_CHAT_RECOVERY_INVENTORY_PAGES;
      pageIndex += 1
    ) {
      signal.throwIfAborted();
      const request = readScheduledChatRecoveryInventoryAsHumanRequestSchema.parse({
        version: 1,
        operation: "scheduled_chat_recovery_inventory_as_human",
        ...vaultState.vault,
        originDeviceId,
        ...(afterSessionId === undefined ? {} : { afterSessionId }),
        pageSize: SCHEDULED_CHAT_INVENTORY_PAGE_SIZE,
      });
      const page = accepted(
        await this.#client.readScheduledChatRecoveryInventory(request, signal),
      );
      if (
        page.kind !== "scheduled_chat_recovery_inventory"
        || !sameVault(page.vault, vaultState.vault)
        || page.originDeviceId !== originDeviceId
        || page.schedules.some((entry) =>
          entry.originDeviceId !== originDeviceId
        )
      ) {
        throw new SessionSyncStoreError(
          "corrupt_state",
          "Cloud schedule recovery inventory returned another vault.",
        );
      }
      for (const entry of page.schedules) {
        if (entries.has(entry.sessionId)) {
          throw new SessionSyncStoreError(
            "corrupt_state",
            "Cloud schedule recovery inventory repeated a session.",
          );
        }
        entries.set(entry.sessionId, entry);
      }
      if (!page.hasMore) break;
      if (page.nextAfterSessionId === undefined) {
        throw new SessionSyncStoreError(
          "corrupt_state",
          "Cloud schedule recovery inventory lost its continuation cursor.",
        );
      }
      afterSessionId = page.nextAfterSessionId;
      if (pageIndex === MAX_SCHEDULED_CHAT_RECOVERY_INVENTORY_PAGES - 1) {
        throw new SessionSyncStoreError(
          "corrupt_state",
          "Cloud schedule recovery inventory exceeded its directory bound.",
        );
      }
    }

    const orphaned = new Map<string, Readonly<{
      sessionId: SessionPublicId;
      paneId: string | null;
      originDeviceId: SyncDeviceId;
      generation: PositiveSyncUint64;
      ciphertextDigest: SyncSha256Digest;
    }>>();
    for (const entry of entries.values()) {
      const binding = this.#store.paneBindingForSession(entry.sessionId);
      const paneId = binding?.originDeviceId === entry.originDeviceId
        ? binding.paneId
        : null;
      if (entry.state === "cleared") {
        if (paneId !== null) {
          const local = schedules.get(paneId);
          const highWater = schedules.generationHighWater(
            paneId,
            entry.sessionId,
          );
          if (
            local !== null
            || highWater === null
            || BigInt(highWater.generation) < BigInt(entry.generation)
          ) {
            const settleAt = this.#now();
            await this.#commitScheduledChatPostimageForPane(paneId, () => {
              schedules.transaction(() => {
                const recovered =
                  this.#settlePendingScheduledMutationThroughHumanClear(
                    schedules,
                    paneId,
                    entry,
                    "human_recovery_inventory",
                    settleAt,
                  );
                if (!recovered) {
                  schedules.reconcileInventoryEntryInTransaction({
                    paneId,
                    entry: {
                      state: "cleared",
                      sessionId: entry.sessionId,
                      originDeviceId: entry.originDeviceId,
                      generation: entry.generation,
                    },
                    now: settleAt,
                  });
                }
                this.#settlePendingScheduledRunAcknowledgmentsThroughHumanClear(
                  schedules,
                  paneId,
                  entry,
                  "human_recovery_inventory",
                  settleAt,
                );
              });
            });
          }
        }
        continue;
      }
      const local = paneId === null ? null : schedules.get(paneId);
      const pendingMutation = paneId === null
        ? null
        : schedules.mutationForPane(paneId);
      const desiredOff = paneId === null
        ? null
        : schedules.desiredOff(paneId);
      if (
        pendingMutation === null
        && desiredOff === null
        && local !== null
        && local.sessionId === entry.sessionId
        && local.generation === entry.generation
        && local.definitionCiphertextDigest === entry.ciphertextDigest
      ) continue;
      const retained = [...this.#orphanedScheduledChats.entries()]
        .find(([, value]) =>
          value.sessionId === entry.sessionId
          && value.paneId === paneId
          && value.originDeviceId === entry.originDeviceId
          && value.generation === entry.generation
          && value.ciphertextDigest === entry.ciphertextDigest
        );
      const orphanId = retained?.[0]
        ?? sessionSyncScheduledChatOrphanIdSchema.parse(
          randomOpaque("syncscheduleorphan"),
        );
      orphaned.set(orphanId, {
        sessionId: entry.sessionId,
        paneId,
        originDeviceId: entry.originDeviceId,
        generation: entry.generation,
        ciphertextDigest: entry.ciphertextDigest,
      });
    }
    if (this.#scheduledChatRecoveryInventoryTargetScope() !== targetScope) {
      throw new SessionSyncCoordinatorError(
        "authority_mismatch",
        "The signed-in cloud authority changed during schedule recovery.",
        true,
      );
    }
    this.#orphanedScheduledChats = orphaned;
    this.#scheduledChatRecoveryInventoryScope = targetScope;
    await this.#discoverLocalOrphanedScheduledChats();
    await this.#publishCurrentStatus();
  }

  async #reconcileScheduledChatInventory(
    authority: SessionSyncProofAuthority,
    signal: AbortSignal,
  ): Promise<void> {
    const schedules = this.#scheduledChatStore;
    if (schedules === null) return;
    let afterSessionId: SessionPublicId | undefined;
    for (
      let pageIndex = 0;
      pageIndex < MAX_SCHEDULED_CHAT_PAGES_PER_CYCLE;
      pageIndex += 1
    ) {
      const page = accepted(await this.#client.execute({
        version: 1,
        operation: "scheduled_chat_inventory",
        ...(afterSessionId === undefined ? {} : { afterSessionId }),
        pageSize: SCHEDULED_CHAT_INVENTORY_PAGE_SIZE,
      }, authority, signal));
      if (page.kind !== "scheduled_chat_inventory") {
        throw new SessionSyncRemoteFailure("LOCAL_UNKNOWN");
      }
      for (const entry of page.schedules) {
        if (entry.originDeviceId !== authority.deviceId) {
          throw new SessionSyncStoreError(
            "corrupt_state",
            "Cloud schedule inventory returned another origin device.",
          );
        }
        if (
          entry.state === "active"
          && !sameVault(entry.definition.header, authority.membership)
        ) {
          throw new SessionSyncStoreError(
            "corrupt_state",
            "Cloud schedule inventory returned another vault.",
          );
        }
        const binding = this.#store.paneBindingForSession(entry.sessionId);
        if (
          binding === null
          || binding.originDeviceId !== authority.deviceId
        ) {
          continue;
        }
        const local = schedules.get(binding.paneId);
        const highWater = schedules.generationHighWater(
          binding.paneId,
          entry.sessionId,
        );
        const current = entry.state === "active"
          && local !== null
          && local.sessionId === entry.sessionId
          && local.generation === entry.generation
          && local.keyEpoch === entry.definition.header.keyEpoch
          && local.rrule === entry.definition.header.rrule
          && local.timeZone === entry.definition.header.timeZone
          && local.nextRunAt === entry.nextRunAt
          && local.definitionCiphertextDigest
            === entry.definition.ciphertextDigest
          && highWater?.generation === entry.generation;
        const cleared = entry.state === "cleared"
          && local === null
          && highWater?.generation === entry.generation;
        if (current || cleared) continue;
        await this.#commitScheduledChatPostimageForPane(binding.paneId, () => {
          schedules.transaction(() => {
            schedules.reconcileInventoryEntryInTransaction({
              paneId: binding.paneId,
              entry,
              now: this.#now(),
            });
          });
        });
      }
      if (!page.hasMore) {
        this.#dropResolvedScheduledChatOrphans();
        return;
      }
      if (page.nextAfterSessionId === undefined) {
        throw new SessionSyncStoreError(
          "corrupt_state",
          "Cloud schedule inventory lost its continuation cursor.",
        );
      }
      afterSessionId = page.nextAfterSessionId;
    }
    throw new SessionSyncStoreError(
      "corrupt_state",
      "Cloud schedule inventory exceeded its bounded page count.",
    );
  }

  #dropResolvedScheduledChatOrphans(): void {
    const schedules = this.#scheduledChatStore;
    if (schedules === null || this.#orphanedScheduledChats.size === 0) return;
    const unresolved = new Map(this.#orphanedScheduledChats);
    for (const [orphanId, orphan] of unresolved) {
      if (orphan.paneId === null) continue;
      const local = schedules.get(orphan.paneId);
      if (
        local?.sessionId === orphan.sessionId
        && local.generation === orphan.generation
        && local.definitionCiphertextDigest === orphan.ciphertextDigest
      ) unresolved.delete(orphanId);
    }
    this.#orphanedScheduledChats = unresolved;
  }

  async #executeScheduledRun(
    run: ScheduledChatRun,
    authority: SessionSyncProofAuthority,
    signal: AbortSignal,
  ): Promise<void> {
    const store = this.#requireScheduledChatStore();
    const enqueue = this.#enqueueScheduledOccurrence;
    if (enqueue === null) throw new SessionSyncRemoteFailure("LOCAL_UNKNOWN");
    const binding = this.#store.paneBindingForSession(run.sessionId);
    const localSchedule = binding === null ? null : store.get(binding.paneId);
    const header = run.definition.header;
    if (
      binding === null
      || binding.state !== "accepted"
      || !binding.included
      || binding.originDeviceId !== authority.deviceId
      || !sameVault(binding.vault, authority.membership)
      || localSchedule === null
      || localSchedule.sessionId !== run.sessionId
      || localSchedule.generation !== run.scheduleGeneration
      || localSchedule.nextRunAt !== run.scheduledFor
      || localSchedule.rrule !== header.rrule
      || localSchedule.timeZone !== header.timeZone
      || localSchedule.keyEpoch !== header.keyEpoch
      || localSchedule.definitionCiphertextDigest
        !== run.definition.ciphertextDigest
      || header.sessionId !== run.sessionId
      || header.generation !== run.scheduleGeneration
      || header.originDeviceId !== authority.deviceId
      || !sameVault(header, authority.membership)
    ) {
      throw new ScheduledChatStoreError(
        "invalid_state",
        "The due scheduled occurrence no longer matches local encrypted authority.",
      );
    }
    const device = this.#store.device();
    if (device?.deviceId !== authority.deviceId) {
      throw new SessionSyncStoreError(
        "stale",
        "Scheduled chat device authority changed.",
      );
    }
    const runtime = await this.#keyCustody.loadRuntime(device.publicKeys);
    if (runtime.vaultRootKeyring === null) {
      throw new SessionSyncStoreError(
        "corrupt_state",
        "The scheduled chat root key is unavailable.",
      );
    }
    const keyring = runtimeKeyring(runtime.vaultRootKeyring);
    let rootKey: Uint8Array;
    if (keyring.rootKeys.some(({ keyEpoch }) => keyEpoch === header.keyEpoch)) {
      rootKey = selectLocalSessionSyncRootKey({
        keyring,
        expectedVault: binding.vault,
        keyEpoch: header.keyEpoch,
      });
    } else {
      const vault = this.#store.vault();
      const currentRoot = keyring.rootKeys.find(({ keyEpoch }) =>
        keyEpoch === keyring.currentRootKeyEpoch
      );
      if (
        vault === null
        || currentRoot === undefined
        || vault.membershipHead.statement.rootKeyEpoch
          !== keyring.currentRootKeyEpoch
      ) {
        throw new SessionSyncStoreError(
          "corrupt_state",
          "The scheduled chat historical root authority is unavailable.",
        );
      }
      rootKey = await deriveSessionSyncHistoricalRootKey({
        expectedVault: binding.vault,
        currentMembershipEpoch: vault.membershipEpoch,
        currentRootKeyEpoch: keyring.currentRootKeyEpoch,
        currentRootKeyCommitment:
          vault.membershipHead.statement.rootKeyCommitment,
        currentRootKeyLinkDigest:
          vault.membershipHead.statement.rootKeyLinkDigest,
        currentRootKey: currentRoot.rootKey,
        targetRootKeyEpoch: header.keyEpoch,
        pages: await this.#rootKeyLinkPages(authority, signal),
      });
    }
    let definition: Awaited<ReturnType<typeof openScheduledChatDefinition>>;
    try {
      definition = await openScheduledChatDefinition({
        envelope: run.definition,
        expectedHeader: header,
        rootKey,
      });
    } finally {
      rootKey.fill(0);
    }
    if (
      definition.sessionId !== run.sessionId
      || definition.generation !== run.scheduleGeneration
      || definition.rrule !== localSchedule.rrule
      || definition.timeZone !== localSchedule.timeZone
    ) {
      throw new ScheduledChatStoreError(
        "corrupt_state",
        "The due scheduled occurrence decrypted to different authority.",
      );
    }
    await enqueue({
      runId: run.runId,
      paneId: binding.paneId,
      sessionId: run.sessionId,
      scheduleGeneration: run.scheduleGeneration,
      occurrenceSequence: run.occurrenceSequence,
      scheduledFor: run.scheduledFor,
      definitionCiphertextDigest: run.definition.ciphertextDigest,
      prompt: definition.prompt,
    });
    const localRun = store.run(run.runId);
    if (localRun === null || localRun.state !== "enqueued") {
      throw new ScheduledChatStoreError(
        "corrupt_state",
        "The scheduled occurrence was not durably enqueued.",
      );
    }
    await this.#acknowledgeScheduledRun(run, authority, signal);
  }

  async #acceptMembership(
    response: Extract<SessionSyncBackendResponse, { kind: "membership" }>,
    authority: SessionSyncProofAuthority,
    signal: AbortSignal,
  ): Promise<void> {
    const current = this.#store.vault();
    if (current?.membershipDigest === response.head.statementDigest) {
      if (
        !sameVault(current.vault, vaultFromHead(response.head))
        || canonicalSessionSyncJson(current.membershipHead)
          !== canonicalSessionSyncJson(response.head)
      ) {
        throw new SessionSyncStoreError(
          "corrupt_state",
          "The authenticated membership response does not match the stored vault head.",
        );
      }
      this.#adoptLegacyHumanApiOriginAfterMembership(response);
      return;
    }
    const expectedVault = current?.vault ?? vaultFromHead(response.head);
    const device = this.#store.device();
    if (device?.deviceId === null || device === null) {
      throw new SessionSyncStoreError("corrupt_state", "Session sync device is missing.");
    }
    const runtime = await this.#keyCustody.loadRuntime(device.publicKeys);
    const keyring = await validateAndUnwrapSessionSyncMembershipRoots({
      head: response.head,
      previousHead: current?.membershipHead ?? null,
      expectedVault,
      expectedDeviceId: device.deviceId,
      expectedPublicKeys: device.publicKeys,
      agreementPrivateKey: runtime.agreementPrivateKey,
      wrappedRoots: response.wrappedRoots,
      rootWrapManifest: response.rootWrapManifest,
    });
    const currentRoot = keyring.rootKeys.find(({ keyEpoch }) =>
      keyEpoch === keyring.currentRootKeyEpoch
    );
    if (currentRoot === undefined) {
      throw new SessionSyncStoreError("corrupt_state", "Session sync root is missing.");
    }
    const pages = keyring.currentRootKeyEpoch === "1"
      ? []
      : await this.#rootKeyLinkPages(authority, signal);
    await verifySessionSyncRootKeyChainToGenesis({
      expectedVault,
      currentMembershipEpoch: response.head.statement.membershipEpoch,
      currentRootKeyEpoch: response.head.statement.rootKeyEpoch,
      currentRootKeyCommitment: response.head.statement.rootKeyCommitment,
      currentRootKeyLinkDigest: response.head.statement.rootKeyLinkDigest,
      currentRootKey: currentRoot.bytes,
      pages,
    });
    if (current === null || runtime.vaultRootKeyring === null) {
      await this.#keyCustody.installVaultRootKeyring({
        expectedPublicKeys: device.publicKeys,
        expectedVaultRootKeyring: runtime.vaultRootKeyring === null
          ? null
          : {
              vault: runtime.vaultRootKeyring.vault,
              membershipEpoch: runtime.vaultRootKeyring.membershipEpoch,
              currentRootKeyEpoch:
                runtime.vaultRootKeyring.currentRootKeyEpoch,
              keyEpochs: runtime.vaultRootKeyring.rootKeys.map(
                ({ keyEpoch }) => keyEpoch,
              ),
            },
        vault: keyring.vault,
        membershipEpoch: keyring.membershipEpoch,
        currentRootKeyEpoch: keyring.currentRootKeyEpoch,
        rootKeys: keyring.rootKeys.map(({ keyEpoch, bytes }) => ({ keyEpoch, rootKey: bytes })),
      });
    } else {
      const operationId = randomOpaque("syncop");
      const request = { kind: "observed_membership", head: response.head };
      const requestDigest = digestSessionSyncJournalValue(request);
      this.#journal.prepare({
        operationId,
        kind: "update_membership",
        request,
        now: this.#now(),
      });
      await this.#keyCustody.prepareVaultRootTransition({
        operationId,
        request,
        requestDigest,
        parentMembershipDigest: current.membershipDigest,
        childMembershipDigest: response.head.statementDigest,
        expectedPublicKeys: device.publicKeys,
        expectedVaultRootKeyring: {
          vault: runtime.vaultRootKeyring.vault,
          membershipEpoch: runtime.vaultRootKeyring.membershipEpoch,
          currentRootKeyEpoch: runtime.vaultRootKeyring.currentRootKeyEpoch,
          keyEpochs: runtime.vaultRootKeyring.rootKeys.map(({ keyEpoch }) => keyEpoch),
        },
        next: {
          vault: keyring.vault,
          membershipEpoch: keyring.membershipEpoch,
          currentRootKeyEpoch: keyring.currentRootKeyEpoch,
          rootKeys: keyring.rootKeys.map(({ keyEpoch, bytes }) => ({ keyEpoch, rootKey: bytes })),
        },
        authenticatedRootHistory: {
          head: response.head,
          pages,
        },
      });
      this.#journal.settle({
        operationId,
        outcome: { kind: "observed", membershipDigest: response.head.statementDigest },
        now: this.#now(),
      });
      await this.#keyCustody.promoteVaultRootTransition({
        operationId,
        requestDigest,
        acceptedMembershipDigest: response.head.statementDigest,
      });
    }
    this.#store.replaceVault({
      expectedRevision: current?.revision ?? null,
      head: response.head,
      wrappedRoot: response.wrappedRoot,
      wrappedRoots: response.wrappedRoots,
      humanAuthority: current?.humanAuthority
        ?? this.#requireCurrentHumanAuthority(),
      now: this.#now(),
    });
    this.#adoptLegacyHumanApiOriginAfterMembership(response);
  }

  #adoptLegacyHumanApiOriginAfterMembership(
    response: Extract<SessionSyncBackendResponse, { kind: "membership" }>,
  ): void {
    const vault = this.#store.vault();
    const scope = this.#safeHumanScope();
    const current = humanAuthorityFromScope(scope);
    if (
      vault?.humanAuthority?.apiOrigin !== null
      || current === null
      || current.apiOrigin === null
    ) return;
    if (
      !legacySessionSyncHumanAuthorityMatches(vault.humanAuthority, scope)
      || !sameVault(vault.vault, vaultFromHead(response.head))
      || vault.membershipDigest !== response.head.statementDigest
    ) {
      throw new SessionSyncStoreError(
        "conflict",
        "The authenticated membership response cannot adopt this legacy vault origin.",
      );
    }
    this.#store.adoptHumanApiOriginAfterAuthenticatedMembership({
      expectedRevision: vault.revision,
      expectedMembershipDigest: vault.membershipDigest,
      expectedUserId: current.userId,
      expectedOrganizationId: current.organizationId,
      apiOrigin: current.apiOrigin,
      now: this.#now(),
    });
  }

  async #rootKeyLinkPages(
    authority: SessionSyncProofAuthority,
    signal: AbortSignal,
  ): Promise<readonly SessionSyncRootKeyLinkPageExchange[]> {
    const pages: SessionSyncRootKeyLinkPageExchange[] = [];
    let before: PositiveSyncUint64 | undefined;
    for (;;) {
      const page = accepted(await this.#client.execute({
        version: 1,
        operation: "root_key_link_page",
        ...(before === undefined ? {} : { beforeChildRootKeyEpoch: before }),
        pageSize: ROOT_LINK_PAGE_SIZE,
      }, authority, signal));
      if (page.kind !== "root_key_link_page") {
        throw new SessionSyncRemoteFailure("LOCAL_UNKNOWN");
      }
      pages.push({
        request: {
          ...(before === undefined ? {} : { beforeChildRootKeyEpoch: before }),
          pageSize: ROOT_LINK_PAGE_SIZE,
        },
        response: {
          links: page.links,
          hasMore: page.hasMore,
          ...(page.nextBeforeChildRootKeyEpoch === undefined
            ? {}
            : { nextBeforeChildRootKeyEpoch: page.nextBeforeChildRootKeyEpoch }),
        },
      });
      if (!page.hasMore) return pages;
      before = page.nextBeforeChildRootKeyEpoch;
    }
  }

  async #observeDirectory(
    authority: SessionSyncProofAuthority,
    signal: AbortSignal,
  ): Promise<void> {
    const cursor = this.#store.directoryCursor();
    const device = this.#store.device();
    const vault = this.#store.vault();
    if (device?.deviceId === null || device === null || vault === null) return;
    if (cursor.mode === "idle") {
      const snapshotId = randomOpaque("syncsnapshot");
      const response = await this.#journaledWireMutation({
        version: 1,
        operation: "begin_snapshot",
        snapshotId,
      }, authority, signal);
      if (response.kind !== "snapshot_started") {
        throw new SessionSyncRemoteFailure("LOCAL_UNKNOWN");
      }
      this.#store.beginSnapshot({
        vault: response.vault,
        snapshotId: response.snapshotId,
        snapshotVersion: response.snapshotVersion,
        now: this.#now(),
      });
      return;
    }
    if (cursor.mode === "snapshot") {
      const response = accepted(await this.#client.execute({
        version: 1,
        operation: "snapshot_page",
        snapshotId: cursor.snapshotId!,
        ...(cursor.snapshotCursor === undefined ? {} : { after: cursor.snapshotCursor }),
        pageSize: DIRECTORY_PAGE_SIZE,
      }, authority, signal));
      if (response.kind !== "snapshot_page") {
        throw new SessionSyncRemoteFailure("LOCAL_UNKNOWN");
      }
      this.#store.installSnapshotPage({
        snapshotId: cursor.snapshotId!,
        expectedCursorRevision: cursor.revision,
        page: response.page,
        localDeviceId: device.deviceId,
        now: this.#now(),
      });
      return;
    }
    const response = accepted(await this.#client.execute({
      version: 1,
      operation: "change_page",
      afterVersion: cursor.changeVersion,
      pageSize: DIRECTORY_PAGE_SIZE,
    }, authority, signal));
    if (response.kind === "resnapshot_required") {
      const snapshotId = randomOpaque("syncsnapshot");
      const started = await this.#journaledWireMutation({
        version: 1,
        operation: "begin_snapshot",
        snapshotId,
      }, authority, signal);
      if (started.kind !== "snapshot_started") {
        throw new SessionSyncRemoteFailure("LOCAL_UNKNOWN");
      }
      this.#store.beginSnapshot({
        vault: started.vault,
        snapshotId: started.snapshotId,
        snapshotVersion: started.snapshotVersion,
        now: this.#now(),
      });
      return;
    }
    if (response.kind !== "change_page") {
      throw new SessionSyncRemoteFailure("LOCAL_UNKNOWN");
    }
    this.#store.applyChangePage({
      expectedCursorRevision: cursor.revision,
      page: response.page,
      localDeviceId: device.deviceId,
      now: this.#now(),
    });
  }

  async #projectRemoteSessions(): Promise<void> {
    const device = this.#store.device();
    const vault = this.#store.vault();
    if (device?.deviceId === null || device === null || vault === null) return;
    const runtime = await this.#keyCustody.loadRuntime(device.publicKeys);
    if (runtime.vaultRootKeyring === null) return;
    const keyring = runtimeKeyring(runtime.vaultRootKeyring);
    const next = new Map<string, string>();
    for (const record of this.#store.remoteRecords(device.deviceId)) {
      const projection = await this.#remoteProjection(record, vault, keyring);
      if (projection === null) continue;
      const serialized = canonicalSessionSyncJson(projection);
      next.set(projection.sessionId, serialized);
      if (this.#projectedRemote.get(projection.sessionId) !== serialized) {
        await this.#projection.publish({
          type: "sessionSync.remote.upserted",
          session: projection,
        });
      }
    }
    for (const sessionId of this.#projectedRemote.keys()) {
      if (!next.has(sessionId)) {
        await this.#projection.publish({
          type: "sessionSync.remote.removed",
          sessionId,
        });
      }
    }
    this.#projectedRemote = next;
  }

  async #remoteProjection(
    record: EncryptedRemoteSessionRecord,
    vault: SessionSyncVaultState,
    keyring: LocalSessionSyncRootKeyring,
  ): Promise<RemoteSessionSummaryProjection | null> {
    if (record.recordKind !== "head" || record.originDeviceId === null) return null;
    const value = record.record as { kind: string; accepted?: unknown };
    if (value.accepted === undefined) return null;
    const acceptedHead = (await import("@hraness/agent-tasks-protocol")).acceptedSessionHeadSchema.parse(value.accepted);
    const header = acceptedHead.envelope.header;
    const rootKey = selectLocalSessionSyncRootKey({
      keyring,
      expectedVault: vault.vault,
      keyEpoch: header.keyEpoch,
    });
    try {
      const contentKey = await deriveSessionContentKey(rootKey, {
        version: 1,
        ...vault.vault,
        sessionId: header.sessionId,
        keyEpoch: header.keyEpoch,
        originDeviceId: header.originDeviceId,
        mirrorEpoch: header.mirrorEpoch,
        writerGeneration: header.writerGeneration,
      }, ["decrypt"]);
      const summary = await openSessionSummary(
        acceptedHead.envelope,
        header,
        contentKey,
      );
      const member = vault.membershipHead.statement.members.find(({ deviceId }) =>
        deviceId === record.originDeviceId
      );
      if (member === undefined) return null;
      const serverObserved = decodeSyncUint64(acceptedHead.serverObservedAt);
      return {
        sessionId: summary.sessionId,
        originDeviceId: record.originDeviceId,
        originDeviceName: member.name,
        gridPosition: record.gridPosition,
        sourceRevision: Number(decodeSyncUint64(summary.sourceRevision)),
        title: summary.title,
        repositoryDisplayName: summary.repositoryDisplayName ?? null,
        state: member.status === "revoked"
          ? "revoked"
          : value.kind === "offline"
          ? "offline"
          : summary.state,
        updatedAt: serverObserved <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(serverObserved)
          : null,
      };
    } catch {
      return null;
    } finally {
      rootKey.fill(0);
    }
  }

  #requireScheduledChatStore(): ScheduledChatStore {
    if (
      this.#scheduledChatStore === null
      || this.#enqueueScheduledOccurrence === null
      || this.#commitScheduledChatPostimage === null
    ) {
      throw new SessionSyncCoordinatorError(
        "capability_unavailable",
        "Encrypted scheduled chats are unavailable.",
      );
    }
    return this.#scheduledChatStore;
  }

  async #recoverDesiredOffIntents(signal: AbortSignal): Promise<void> {
    const store = this.#requireScheduledChatStore();
    for (const desired of store.desiredOffIntents()) {
      signal.throwIfAborted();
      if (store.mutationForPane(desired.paneId) !== null) return;
      await this.#clearDesiredOffIntent(desired, signal, true);
      if (store.desiredOff(desired.paneId) !== null) return;
    }
  }

  async #clearDesiredOffIntent(
    expected: LocalScheduledChatDesiredOff,
    signal: AbortSignal,
    notifyProjection: boolean,
  ): Promise<void> {
    const store = this.#requireScheduledChatStore();
    const desired = store.desiredOff(expected.paneId);
    if (desired === null) return;
    if (
      desired.sessionId !== expected.sessionId
      || desired.targetGeneration !== expected.targetGeneration
    ) {
      throw new ScheduledChatStoreError(
        "conflict",
        "The durable schedule off intent changed during recovery.",
      );
    }
    if (store.mutationForPane(desired.paneId) !== null) {
      throw new ScheduledChatStoreError(
        "invalid_state",
        "Wait for the pending schedule change before turning off this chat.",
      );
    }
    const current = store.get(desired.paneId);
    if (current === null) {
      const settle = () => store.settleDesiredOffWithoutSchedule(desired.paneId);
      if (notifyProjection) {
        await this.#commitScheduledChatPostimageForPane(
          desired.paneId,
          settle,
        );
      } else {
        settle();
      }
      return;
    }
    if (
      current.sessionId !== desired.sessionId
      || current.generation !== desired.targetGeneration
    ) {
      throw new ScheduledChatStoreError(
        "conflict",
        "The active schedule no longer matches its durable off intent.",
      );
    }
    const authority = await this.#scheduledChatAuthority(desired.paneId);
    if (current.sessionId !== authority.binding.sessionId) {
      throw new SessionSyncCoordinatorError(
        "conflict",
        "This scheduled chat belongs to a different synced session.",
      );
    }
    const request = clearScheduledChatRequestSchema.parse({
      version: 1,
      operation: "clear_scheduled_chat",
      ...authority.vault.vault,
      membershipEpoch: authority.vault.membershipEpoch,
      originDeviceId: authority.deviceId,
      sessionId: authority.binding.sessionId,
      mirrorEpoch: authority.head.mirrorEpoch,
      writerGeneration: authority.head.writerGeneration,
      bootId: authority.boot.bootId,
      bootGeneration: authority.boot.bootGeneration,
      keyEpoch: authority.vault.rootKeyEpoch,
      expectedGeneration: current.generation,
    });
    const operationId = randomOpaque("syncop");
    const now = this.#now();
    const mutation = store.transaction(() => {
      this.#journal.prepare({
        operationId,
        kind: "clear_scheduled_chat",
        sessionId: authority.binding.sessionId,
        request,
        now,
      });
      return store.prepareClear({
        operationId,
        paneId: desired.paneId,
        sessionId: authority.binding.sessionId,
        expectedPaneRevision: store.paneRevision(desired.paneId),
        targetGeneration: current.generation,
        request,
        now,
      });
    });
    await this.#dispatchScheduledMutation(
      mutation,
      authority.proof,
      signal,
      notifyProjection,
    );
  }

  async #commitScheduledChatPostimageForPane(
    paneId: string,
    commit: () => void,
  ): Promise<void> {
    const callback = this.#commitScheduledChatPostimage;
    if (callback === null) {
      throw new SessionSyncCoordinatorError(
        "capability_unavailable",
        "Scheduled chat postimage coordination is unavailable.",
      );
    }
    let calls = 0;
    await callback(paneId, () => {
      calls += 1;
      if (calls !== 1) {
        throw new SessionSyncCoordinatorError(
          "conflict",
          "Scheduled chat postimage commit was invoked more than once.",
        );
      }
      commit();
    });
    if (calls !== 1) {
      throw new SessionSyncCoordinatorError(
        "operation_failed",
        "Scheduled chat postimage commit was not invoked.",
      );
    }
  }

  async #recoverScheduledChatOperation(
    entry: SessionSyncOperationJournalEntry,
    signal: AbortSignal,
  ): Promise<boolean> {
    const store = this.#scheduledChatStore;
    if (store === null) return false;
    const priorAuthority = await this.#authority();
    if (priorAuthority === null) return false;
    const membership = accepted(await this.#client.execute({
      version: 1,
      operation: "read_membership",
    }, priorAuthority, signal));
    if (membership.kind !== "membership") {
      throw new SessionSyncRemoteFailure("LOCAL_UNKNOWN");
    }
    await this.#acceptMembership(membership, priorAuthority, signal);
    this.#membershipResponse = membership;
    const authority = await this.#authority();
    if (authority === null) return false;
    if (entry.kind === "ack_scheduled_run") {
      const request = acknowledgeScheduledChatRunRequestSchema.parse(
        entry.request,
      );
      await this.#dispatchScheduledRunAcknowledgment(
        entry.operationId,
        request,
        authority,
        signal,
      );
      return true;
    }
    if (
      entry.kind !== "put_scheduled_chat"
      && entry.kind !== "clear_scheduled_chat"
    ) return false;
    const mutation = store.mutation(entry.operationId);
    if (mutation === null) {
      throw new ScheduledChatStoreError(
        "corrupt_state",
        "The exact encrypted schedule replay lost its local mutation fence.",
      );
    }
    await this.#dispatchScheduledMutation(mutation, authority, signal);
    return true;
  }

  async #recoverSessionPublicationOperation(
    entry: SessionSyncOperationJournalEntry,
    signal: AbortSignal,
  ): Promise<boolean> {
    const request = publishSyncSessionRequestSchema.parse(entry.request);
    const sessionId = request.envelope.header.sessionId;
    if (
      entry.scope.sessionId !== sessionId
      || entry.requestDigest !== digestSessionSyncJournalValue(request)
    ) {
      throw new SessionSyncStoreError(
        "corrupt_state",
        "The session publication lost its exact replay authority.",
      );
    }
    const attempt = this.#store.attempt(sessionId);
    const exactEnvelopeJson = canonicalSessionSyncJson(request.envelope);
    if (
      attempt !== null
      && canonicalSessionSyncJson(attempt.envelope) !== exactEnvelopeJson
    ) {
      throw new SessionSyncStoreError(
        "corrupt_state",
        "The session publication journal disagrees with its persisted envelope.",
      );
    }

    const priorAuthority = await this.#authority();
    if (priorAuthority === null) return false;
    const membership = accepted(await this.#client.execute({
      version: 1,
      operation: "read_membership",
    }, priorAuthority, signal));
    if (membership.kind !== "membership") {
      throw new SessionSyncRemoteFailure("LOCAL_UNKNOWN");
    }
    await this.#acceptMembership(membership, priorAuthority, signal);
    this.#membershipResponse = membership;
    const authority = await this.#authority();
    if (authority === null) return false;

    const result = await this.#client.execute(request, authority, signal);
    if (!result.ok) {
      this.#journal.markAmbiguous(
        entry.operationId,
        Math.max(this.#now(), entry.updatedAt),
      );
      return accepted(result);
    }
    const response = result.data;
    if (
      response.kind !== "session_accepted"
      || canonicalSessionSyncJson(response.accepted.envelope) !== exactEnvelopeJson
    ) {
      this.#journal.markAmbiguous(
        entry.operationId,
        Math.max(this.#now(), entry.updatedAt),
      );
      throw new SessionSyncRemoteFailure("LOCAL_UNKNOWN");
    }

    if (attempt !== null) {
      if (!this.#store.settleAccepted({
        accepted: response.accepted,
        now: Math.max(this.#now(), entry.updatedAt),
      })) {
        throw new SessionSyncStoreError(
          "stale",
          "The exact session publication could not install its local acknowledgement.",
        );
      }
    } else {
      const head = this.#store.localHead(sessionId);
      if (
        head === null
        || head.syncState !== "idle"
        || head.mirrorEpoch !== request.envelope.header.mirrorEpoch
        || head.writerGeneration !== request.envelope.header.writerGeneration
        || head.bootId !== request.envelope.header.bootId
        || head.bootGeneration !== request.envelope.header.bootGeneration
        || head.acknowledgedSequence !== request.envelope.header.syncSequence
        || head.acknowledgedDigest !== request.envelope.ciphertextDigest
        || head.acknowledgedSourceRevision !== Number(
          decodeSyncUint64(request.envelope.header.sourceRevision),
        )
      ) {
        throw new SessionSyncStoreError(
          "corrupt_state",
          "The exact session publication response lost its local postimage.",
        );
      }
    }
    this.#journal.settle({
      operationId: entry.operationId,
      outcome: { kind: "accepted", response },
      now: Math.max(this.#now(), entry.updatedAt),
    });
    return true;
  }

  async #scheduledChatAuthority(paneId: string) {
    this.#requireScheduledChatStore();
    if (!this.#cloudConfigured || !this.#store.settings().enabled) {
      throw new SessionSyncCoordinatorError(
        "capability_unavailable",
        "Enable encrypted session sync before scheduling this chat.",
      );
    }
    const vault = this.#store.vault();
    const device = this.#store.device();
    const boot = this.#store.boot();
    const binding = this.#store.paneBinding(paneId);
    if (
      vault?.state !== "active"
      || device?.enrollmentState !== "active"
      || device.deviceId === null
      || boot?.acknowledged !== true
      || boot.bootGeneration === null
      || binding === null
      || binding.state !== "accepted"
      || !binding.included
      || binding.originDeviceId !== device.deviceId
      || !sameVault(binding.vault, vault.vault)
      || !sessionSyncHumanAuthorityMatches(
        vault.humanAuthority,
        this.#safeHumanScope(),
      )
    ) {
      throw new SessionSyncCoordinatorError(
        "invalid_state",
        "This chat does not have current encrypted session authority.",
        true,
      );
    }
    const head = this.#store.localHead(binding.sessionId);
    if (
      head === null
      || head.directoryOrdinal === null
      || head.writerGeneration === "0"
      || head.bootId !== boot.bootId
      || head.bootGeneration !== boot.bootGeneration
      || head.membershipEpoch !== vault.membershipEpoch
      || head.keyEpoch !== vault.rootKeyEpoch
      || head.syncState === "conflict"
      || head.syncState === "rekey_required"
      || head.syncState === "revoked"
    ) {
      throw new SessionSyncCoordinatorError(
        "invalid_state",
        "This chat's encrypted writer authority is not current.",
        true,
      );
    }
    const keys = await this.#keyCustody.loadRuntime(device.publicKeys);
    if (
      keys.vaultRootKeyring === null
      || !sameVault(keys.vaultRootKeyring.vault, vault.vault)
      || keys.vaultRootKeyring.membershipEpoch !== vault.membershipEpoch
      || keys.vaultRootKeyring.currentRootKeyEpoch !== vault.rootKeyEpoch
    ) {
      throw new SessionSyncCoordinatorError(
        "invalid_state",
        "This device does not hold the current encrypted schedule key.",
        true,
      );
    }
    return {
      binding,
      boot,
      deviceId: device.deviceId,
      head: {
        ...head,
        writerGeneration: positiveSyncUint64Schema.parse(head.writerGeneration),
      },
      keyring: runtimeKeyring(keys.vaultRootKeyring),
      proof: {
        membership: { ...vault.vault, membershipEpoch: vault.membershipEpoch },
        deviceId: device.deviceId,
        keys,
      } satisfies SessionSyncProofAuthority,
      vault,
    } as const;
  }

  async #dispatchScheduledMutation(
    mutation: LocalScheduledChatMutation,
    authority: SessionSyncProofAuthority,
    signal: AbortSignal,
    notifyProjection = true,
  ): Promise<void> {
    const store = this.#requireScheduledChatStore();
    const request: PutScheduledChatRequest | ClearScheduledChatRequest =
      mutation.kind === "put"
        ? putScheduledChatRequestSchema.parse(mutation.request)
        : clearScheduledChatRequestSchema.parse(mutation.request);
    let journal = this.#journal.get(mutation.operationId);
    if (
      journal === null
      || journal.scope.sessionId !== mutation.sessionId
      || journal.requestDigest !== mutation.requestDigest
      || canonicalSessionSyncJson(journal.request)
        !== canonicalSessionSyncJson(request)
      || journal.kind !== request.operation
    ) {
      throw new ScheduledChatStoreError(
        "corrupt_state",
        "The encrypted schedule mutation lost its exact replay authority.",
      );
    }
    if (journal.state === "terminal") {
      throw new ScheduledChatStoreError(
        "corrupt_state",
        "A terminal encrypted schedule mutation retained local pending work.",
      );
    }
    // A put or clear may apply while its response is lost. Force the next
    // human recovery read to observe that cloud state instead of trusting an
    // inventory page captured before this exact effect crossed its fence.
    this.#scheduledChatRecoveryInventoryScope = null;
    const dispatchAt = Math.max(this.#now(), journal.updatedAt, mutation.updatedAt);
    if (journal.state === "prepared" && mutation.state === "prepared") {
      store.transaction(() => {
        store.markEffectStarted(mutation.operationId, dispatchAt);
        this.#journal.markDispatched(mutation.operationId, dispatchAt);
      });
      journal = this.#journal.get(mutation.operationId);
    } else if (
      (journal.state === "dispatched" || journal.state === "ambiguous")
      && mutation.state === "effect_started"
    ) {
      // Exact replay resumes the immutable request after a lost response.
    } else {
      throw new ScheduledChatStoreError(
        "corrupt_state",
        "The encrypted schedule mutation fences disagree.",
      );
    }
    let result: SessionSyncSessionResult<SessionSyncBackendResponse>;
    try {
      result = await this.#client.execute(request, authority, signal);
    } catch (error) {
      this.#journal.markAmbiguous(
        mutation.operationId,
        Math.max(this.#now(), journal?.updatedAt ?? dispatchAt),
      );
      throw error;
    }
    if (!result.ok) {
      const failureAt = Math.max(
        this.#now(),
        this.#journal.get(mutation.operationId)?.updatedAt ?? dispatchAt,
      );
      if (result.kind === "session") {
        this.#journal.markAmbiguous(mutation.operationId, failureAt);
      } else {
        const rejectPostimage = () => store.transaction(() => {
          store.rejectMutationInTransaction(mutation.operationId);
          this.#journal.settle({
            operationId: mutation.operationId,
            outcome: { kind: "rejected", code: result.error.code },
            now: failureAt,
          });
        });
        if (notifyProjection) {
          await this.#commitScheduledChatPostimageForPane(
            mutation.paneId,
            rejectPostimage,
          );
        } else {
          rejectPostimage();
        }
      }
      return accepted(result);
    }
    const response = result.data;
    const settleAt = Math.max(
      this.#now(),
      this.#journal.get(mutation.operationId)?.updatedAt ?? dispatchAt,
      mutation.updatedAt,
    );
    let commitPostimage: () => void;
    if (mutation.kind === "put" && response.kind === "scheduled_chat_put") {
      commitPostimage = () => store.transaction(() => {
        store.completeMutationInTransaction(
          mutation.operationId,
          settleAt,
          response,
        );
        this.#journal.settle({
          operationId: mutation.operationId,
          outcome: { kind: "accepted", response },
          now: settleAt,
        });
      });
    } else if (
      mutation.kind === "clear"
      && response.kind === "scheduled_chat_cleared"
    ) {
      commitPostimage = () => store.transaction(() => {
        store.completeMutationInTransaction(
          mutation.operationId,
          settleAt,
          response,
        );
        this.#journal.settle({
          operationId: mutation.operationId,
          outcome: { kind: "accepted", response },
          now: settleAt,
        });
      });
    } else {
      this.#journal.markAmbiguous(
        mutation.operationId,
        settleAt,
      );
      throw new SessionSyncRemoteFailure("LOCAL_UNKNOWN");
    }
    if (notifyProjection) {
      await this.#commitScheduledChatPostimageForPane(
        mutation.paneId,
        commitPostimage,
      );
    } else {
      commitPostimage();
    }
  }

  async #acknowledgeScheduledRun(
    run: ScheduledChatRun,
    authority: SessionSyncProofAuthority,
    signal: AbortSignal,
  ): Promise<void> {
    const boot = this.#store.boot();
    if (boot?.acknowledged !== true || boot.bootGeneration === null) {
      throw new SessionSyncCoordinatorError(
        "invalid_state",
        "The scheduled occurrence cannot be acknowledged without a current boot.",
        true,
      );
    }
    const request = acknowledgeScheduledChatRunRequestSchema.parse({
      version: 1,
      operation: "ack_scheduled_run",
      bootId: boot.bootId,
      bootGeneration: boot.bootGeneration,
      runId: run.runId,
      sessionId: run.sessionId,
      scheduleGeneration: run.scheduleGeneration,
      occurrenceSequence: run.occurrenceSequence,
      scheduledFor: run.scheduledFor,
    });
    const operationId = randomOpaque("syncop");
    this.#journal.prepare({
      operationId,
      kind: "ack_scheduled_run",
      sessionId: run.sessionId,
      request,
      now: this.#now(),
    });
    await this.#dispatchScheduledRunAcknowledgment(
      operationId,
      request,
      authority,
      signal,
    );
  }

  async #dispatchScheduledRunAcknowledgment(
    operationId: string,
    request: AcknowledgeScheduledChatRunRequest,
    authority: SessionSyncProofAuthority,
    signal: AbortSignal,
  ): Promise<void> {
    const store = this.#requireScheduledChatStore();
    let journal = this.#journal.get(operationId);
    if (
      journal === null
      || journal.kind !== "ack_scheduled_run"
      || journal.scope.sessionId !== request.sessionId
      || canonicalSessionSyncJson(journal.request)
        !== canonicalSessionSyncJson(request)
    ) {
      throw new ScheduledChatStoreError(
        "corrupt_state",
        "The scheduled occurrence acknowledgment lost exact replay authority.",
      );
    }
    const localRun = store.run(request.runId);
    if (
      localRun === null
      || localRun.scheduleGeneration !== request.scheduleGeneration
      || localRun.occurrenceSequence !== request.occurrenceSequence
      || localRun.scheduledFor !== request.scheduledFor
    ) {
      throw new ScheduledChatStoreError(
        "corrupt_state",
        "The scheduled occurrence acknowledgment lost its local run fence.",
      );
    }
    if (journal.state === "terminal") {
      if (localRun.state !== "acknowledged") {
        throw new ScheduledChatStoreError(
          "corrupt_state",
          "A terminal scheduled occurrence acknowledgment retained pending work.",
        );
      }
      return;
    }
    const dispatchAt = Math.max(this.#now(), journal.updatedAt);
    if (journal.state === "prepared") {
      journal = this.#journal.markDispatched(operationId, dispatchAt);
    }
    let result: SessionSyncSessionResult<SessionSyncBackendResponse>;
    try {
      result = await this.#client.execute(request, authority, signal);
    } catch (error) {
      this.#journal.markAmbiguous(
        operationId,
        Math.max(this.#now(), journal.updatedAt),
      );
      throw error;
    }
    if (!result.ok) {
      const failureAt = Math.max(this.#now(), journal.updatedAt);
      if (result.kind === "session") {
        this.#journal.markAmbiguous(operationId, failureAt);
      } else {
        this.#journal.settle({
          operationId,
          outcome: { kind: "rejected", code: result.error.code },
          now: failureAt,
        });
      }
      return accepted(result);
    }
    const response = result.data;
    if (
      response.kind !== "scheduled_run_acknowledged"
      || response.runId !== request.runId
      || response.sessionId !== request.sessionId
      || response.generation !== request.scheduleGeneration
    ) {
      this.#journal.markAmbiguous(
        operationId,
        Math.max(this.#now(), journal.updatedAt),
      );
      throw new SessionSyncRemoteFailure("LOCAL_UNKNOWN");
    }
    const settleAt = Math.max(this.#now(), journal.updatedAt);
    await this.#commitScheduledChatPostimageForPane(localRun.paneId, () => {
      store.transaction(() => {
      store.acknowledgeRunInTransaction({
        runId: request.runId,
        expectedPaneId: localRun.paneId,
        expectedSessionId: localRun.sessionId,
        expectedScheduleGeneration: request.scheduleGeneration,
        expectedOccurrenceSequence: request.occurrenceSequence,
        expectedScheduledFor: request.scheduledFor,
        nextRunAt: response.nextRunAt,
        now: settleAt,
      });
      this.#journal.settle({
        operationId,
        outcome: { kind: "accepted", response },
        now: settleAt,
      });
      });
    });
  }

  async #authority(): Promise<SessionSyncProofAuthority | null> {
    const device = this.#store.device();
    const vault = this.#store.vault();
    if (
      device?.enrollmentState !== "active"
      || device.deviceId === null
      || vault?.state !== "active"
      || (
        !sessionSyncHumanAuthorityMatches(
          vault.humanAuthority,
          this.#safeHumanScope(),
        )
        && !legacySessionSyncHumanAuthorityMatches(
          vault.humanAuthority,
          this.#safeHumanScope(),
        )
      )
    ) return null;
    const keys = await this.#keyCustody.loadRuntime(device.publicKeys);
    return {
      membership: { ...vault.vault, membershipEpoch: vault.membershipEpoch },
      deviceId: device.deviceId,
      keys,
    };
  }

  async #journaledWireMutation(
    request: SessionSyncBackendRequest,
    authority: SessionSyncProofAuthority,
    signal: AbortSignal,
  ): Promise<SessionSyncBackendResponse> {
    const kind = request.operation as SessionSyncMutationKind;
    const sessionId = "sessionId" in request
      ? request.sessionId
      : request.operation === "publish_session"
        ? request.envelope.header.sessionId
        : undefined;
    return await this.#journaledMutation(
      kind,
      request,
      async () => await this.#client.execute(request, authority, signal),
      sessionId,
    );
  }

  async #journaledHumanMutation<Value extends SessionSyncBackendResponse>(
    kind: SessionSyncHumanOperation & SessionSyncMutationKind,
    request: unknown,
    run: () => Promise<SessionSyncSessionResult<Value>>,
  ): Promise<Value> {
    return await this.#journaledMutation(kind, request, run);
  }

  async #journaledMutation<Value extends SessionSyncBackendResponse>(
    kind: SessionSyncMutationKind,
    request: unknown,
    run: () => Promise<SessionSyncSessionResult<Value>>,
    sessionId?: Parameters<SessionSyncOperationJournal["prepare"]>[0]["sessionId"],
  ): Promise<Value> {
    const operationId = randomOpaque("syncop");
    this.#journal.prepare({
      operationId,
      kind,
      request,
      ...(sessionId === undefined ? {} : { sessionId }),
      now: this.#now(),
    });
    this.#journal.markDispatched(operationId, this.#now());
    let result: SessionSyncSessionResult<Value>;
    try {
      result = await run();
    } catch (error) {
      this.#journal.markAmbiguous(operationId, this.#now());
      throw error;
    }
    if (!result.ok) {
      if (result.kind === "session") {
        this.#journal.markAmbiguous(operationId, this.#now());
      } else {
        this.#journal.settle({
          operationId,
          outcome: { kind: "rejected", code: result.error.code },
          now: this.#now(),
        });
      }
      return accepted(result);
    }
    this.#journal.settle({
      operationId,
      outcome: { kind: "accepted", response: result.data },
      now: this.#now(),
    });
    return result.data;
  }

  async #publishLocalGrid(): Promise<void> {
    await this.#projection.publish({
      type: "sessionSync.localGrid.changed",
      slots: this.#store.localGridSlots(),
    });
  }

  async #publishCurrentStatus(
    _revision?: number,
    failure?: unknown,
  ): Promise<void> {
    const status = this.#currentStatus(failure);
    const serialized = canonicalSessionSyncJson(status);
    if (serialized === this.#lastStatusJson) return;
    this.#lastStatusJson = serialized;
    await this.#projection.publish({ type: "sessionSync.statusChanged", status });
  }

  #currentStatus(failure?: unknown): SessionSyncStatusProjection {
    const settings = this.#store.settings();
    if (!this.#cloudConfigured) {
      return { state: "unavailable", reason: "cloudConfigurationMissing", retryable: false };
    }
    const scope = this.#safeHumanScope();
    if (scope?.signedIn !== true) {
      return { state: "unavailable", reason: "signedOut", retryable: true };
    }
    if (!settings.enabled && this.#orphanedScheduledChats.size === 0) {
      return { state: "disabled", revision: settings.revision, deviceName: settings.deviceName };
    }
    if (failure !== undefined && retryCode(failure) === "LOCAL_KEYCHAIN_UNAVAILABLE") {
      return { state: "unavailable", reason: "keychainUnavailable", retryable: true };
    }
    const device = this.#store.device();
    const vault = this.#store.vault();
    if (
      vault !== null
      && !sessionSyncHumanAuthorityMatches(vault.humanAuthority, scope)
    ) {
      return { state: "unavailable", reason: "serviceUnavailable", retryable: false };
    }
    if (
      device?.enrollmentState !== "active"
      || device.deviceId === null
      || vault?.state !== "active"
    ) {
      return { state: "unavailable", reason: "serviceUnavailable", retryable: true };
    }
    const membership = this.#membershipResponse;
    const presence = new Map(
      membership?.devicePresence.map((item) => [item.deviceId, item.connection]) ?? [],
    );
    const retrying = (["enrollment", "publisher", "observer", "heartbeat"] as const)
      .some((worker) => this.#store.retry(worker) !== null);
    const localPaneBindingAdmission = this.#localPaneBindingAdmission;
    const localCapacityReached =
      localPaneBindingAdmission?.status === "capacity_reached";
    return {
      state: "active",
      revision: settings.revision,
      scopeGeneration: this.#scopeGeneration,
      currentDeviceId: device.deviceId,
      deviceName: settings.deviceName,
      health: retrying || localCapacityReached || this.#orphanedScheduledChats.size > 0
        ? "attention"
        : "current",
      retryable: retrying,
      notice: retrying
        ? "Encrypted session sync will retry without interrupting local chat."
        : localCapacityReached
          ? `This device retains ${String(localPaneBindingAdmission.bindingCount)} synced sessions. Additional panes remain local-only.`
          : this.#orphanedScheduledChats.size > 0
            ? "Cloud schedules need recovery before scheduled messages can run."
            : null,
      recovery: this.#recoveryAcknowledged ? "ready" : "exportRequired",
      devices: vault.membershipHead.statement.members.map((member) => ({
        id: member.deviceId,
        name: member.name,
        status: member.status,
        current: member.deviceId === device.deviceId,
        connection: member.status === "revoked"
          ? "offline"
          : presence.get(member.deviceId) ?? "unknown",
      })),
      pendingEnrollments: this.#pendingEnrollments.map((request) => ({
        requestId: request.requestId,
        deviceId: request.deviceId,
        name: request.name,
        pairingCode: request.pairingCode,
        requestedAt: Number(decodeSyncUint64(request.createdAt)),
        expiresAt: Number(decodeSyncUint64(request.expiresAt)),
      })),
      scheduledChatRecovery: this.#orphanedScheduledChats.size === 0
        ? null
        : {
            state: "clearRequired",
            orphans: this.orphanedScheduledChats(),
          },
    };
  }

  async #clearRemoteProjection(): Promise<void> {
    if (this.#projectedRemote.size > 0) {
      this.#projectedRemote.clear();
      await this.#projection.publish({ type: "sessionSync.remote.cleared" });
    }
  }

  async #revealRecoveryKit(): Promise<SessionSyncCommandResult> {
    const vault = this.#store.vault();
    if (
      vault?.state !== "active"
      || !sessionSyncHumanAuthorityMatches(
        vault.humanAuthority,
        this.#safeHumanScope(),
      )
    ) {
      throw new SessionSyncCoordinatorError(
        "authority_mismatch",
        "The recovery key is available only to its exact signed-in human scope.",
      );
    }
    const metadata = await this.#recoveryCustody.metadata();
    if (
      metadata === null
      || canonicalSessionSyncJson(metadata.authority.vault)
        !== canonicalSessionSyncJson(vault.vault)
      || metadata.authority.recoveryGeneration
        !== vault.membershipHead.statement.recoveryGeneration
    ) {
      throw new SessionSyncCoordinatorError(
        "invalid_state",
        "This device does not hold the vault recovery key.",
      );
    }
    const kit = await this.#recoveryCustody.loadForExplicitReveal(metadata.authority);
    const value = canonicalSessionSyncJson(kit);
    const revealId = randomOpaque("syncreveal");
    const expiresAt = this.#now() + RECOVERY_REVEAL_TTL_MS;
    this.#clearReveal();
    this.#reveal = { id: revealId, value, expiresAt };
    this.#revealTimer = setTimeout(() => this.#clearReveal(), RECOVERY_REVEAL_TTL_MS);
    return { type: "sessionSyncRecoveryKit", revealId, recoveryKit: value, expiresAt };
  }

  #clearReveal(): void {
    if (this.#revealTimer !== null) clearTimeout(this.#revealTimer);
    this.#revealTimer = null;
    this.#reveal = null;
  }

  #approveEnrollment(requestId: string, pairingCode: string): void {
    const request = this.#pendingEnrollments.find((candidate) => candidate.requestId === requestId);
    if (request === undefined || request.pairingCode !== pairingCode) {
      throw new SessionSyncCoordinatorError(
        "conflict",
        "The enrollment request or pairing code changed.",
      );
    }
    this.#changeMembership({ kind: "approve", request });
  }

  #changeMembership(change:
    | Readonly<{ kind: "approve"; request: PendingSessionSyncEnrollment }>
    | Readonly<{ kind: "revoke"; deviceId: SyncDeviceId }>
    | Readonly<{ kind: "rotate_recovery" }>): void {
    void change;
    throw new SessionSyncCoordinatorError(
      "invalid_state",
      "The requested membership transition cannot be completed from the current accepted authority.",
      true,
    );
  }

  #importRecovery(serialized: string): void {
    void serialized;
    throw new SessionSyncCoordinatorError(
      "invalid_state",
      "Recovery import requires a matching relay recovery context.",
      true,
    );
  }

  #resetVault(): void {
    throw new SessionSyncCoordinatorError(
      "upstream_ambiguous",
      "The encrypted vault reset was not acknowledged. Local sessions were preserved.",
      true,
    );
  }
}
