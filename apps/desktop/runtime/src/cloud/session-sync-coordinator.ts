import {
  SESSION_SYNC_PROTOCOL,
  canonicalSessionSyncJson,
  commitSyncVaultRootKey,
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
  positiveSyncUint64Schema,
  sealSessionSummary,
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
  type PositiveSyncUint64,
  type SessionSyncBackendRequest,
  type SessionSyncBackendResponse,
  type SyncDeviceId,
  type SyncMembershipHead,
  type SyncVaultCoordinate,
} from "@hraness/agent-tasks-protocol";
import {
  runtimeSessionSyncCapabilities,
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
import { abortableSleep } from "./abortable-sleep";

const WORKER_POLL_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const DIRECTORY_PAGE_SIZE = 100;
const ROOT_LINK_PAGE_SIZE = 100;
const RECOVERY_REVEAL_TTL_MS = 5 * 60_000;

type SessionSyncWorker = SessionSyncRetryState["worker"];
type PendingSessionSyncEnrollment = Extract<
  SessionSyncBackendResponse,
  { kind: "enrollment_requests" }
>["requests"][number];

export interface SessionSyncHumanScope {
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
    || scope.userId === null
    || scope.organizationId === null
    || scope.userId.length < 1
    || scope.organizationId.length < 1
  ) return null;
  return { userId: scope.userId, organizationId: scope.organizationId };
}

export function sessionSyncHumanAuthorityMatches(
  bound: SessionSyncHumanAuthority | null,
  scope: SessionSyncHumanScope | null,
): boolean {
  const current = humanAuthorityFromScope(scope);
  return bound !== null
    && current !== null
    && bound.userId === current.userId
    && bound.organizationId === current.organizationId;
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

export class SessionSyncCoordinator {
  readonly #client: SessionSyncBearerClient;
  readonly #cloudConfigured: boolean;
  readonly #humanScope: () => SessionSyncHumanScope | null;
  readonly #journal: SessionSyncOperationJournal;
  readonly #keyCustody: SessionSyncKeyCustody;
  readonly #now: () => number;
  readonly #projection: SessionSyncProjectionPort;
  readonly #random: () => number;
  readonly #recoveryCustody: SessionSyncRecoveryKeyCustody;
  readonly #store: SessionSyncStore;
  #abort: AbortController | null = null;
  #commandTail: Promise<void> = Promise.resolve();
  #exclusiveTail: Promise<void> = Promise.resolve();
  #lastScopeFingerprint: string | null = null;
  #lastStatusJson: string | null = null;
  #localPaneBindingAdmission: SessionSyncLocalPaneBindingAdmission | null = null;
  #membershipResponse: Extract<SessionSyncBackendResponse, { kind: "membership" }> | null = null;
  #pendingEnrollments: Extract<SessionSyncBackendResponse, { kind: "enrollment_requests" }>["requests"] = [];
  #projectedRemote = new Map<string, string>();
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
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
  }

  start(): void {
    if (this.#abort !== null) return;
    const abort = new AbortController();
    this.#abort = abort;
    this.#tasks = [this.#startWorkersAfterRecovery(abort.signal)];
    void this.#publishCurrentStatus().catch(() => undefined);
  }

  async #startWorkersAfterRecovery(signal: AbortSignal): Promise<void> {
    await this.#withExclusive(async () => {
      await this.#recoverRestartWork(signal);
    });
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

  async execute(
    command: RuntimeSessionSyncDomainCommand,
  ): Promise<SessionSyncCommandResult> {
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
  }

  async authenticationChanged(): Promise<void> {
    await this.#observeScope();
    await this.#publishCurrentStatus();
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
        if (!runtimeSessionSyncCapabilities.enrollmentApproval) {
          throw new SessionSyncCoordinatorError(
            "capability_unavailable",
            "Device approval is not available in this build.",
          );
        }
        this.#approveEnrollment(command.requestId, command.pairingCode);
        return { type: "accepted" };
      case "sessionSync.device.revoke":
        if (!runtimeSessionSyncCapabilities.deviceRevocation) {
          throw new SessionSyncCoordinatorError(
            "capability_unavailable",
            "Device revocation is not available in this build.",
          );
        }
        this.#changeMembership({ kind: "revoke", deviceId: command.deviceId });
        return { type: "accepted" };
      case "sessionSync.recovery.rotate":
        if (!runtimeSessionSyncCapabilities.recoveryRotation) {
          throw new SessionSyncCoordinatorError(
            "capability_unavailable",
            "Recovery rotation is not available in this build.",
          );
        }
        this.#changeMembership({ kind: "rotate_recovery" });
        return { type: "accepted" };
      case "sessionSync.recovery.import":
        if (!runtimeSessionSyncCapabilities.recoveryImport) {
          throw new SessionSyncCoordinatorError(
            "capability_unavailable",
            "Recovery import is not available in this build.",
          );
        }
        this.#importRecovery(command.recoveryKit);
        return { type: "accepted" };
      case "sessionSync.reset":
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
    const retry = this.#store.retry(worker);
    if (retry !== null && retry.notBefore > this.#now()) return;
    try {
      const scopeReady = await this.#observeScope();
      if (!scopeReady || !this.#store.settings().enabled) {
        await this.#publishCurrentStatus();
        return;
      }
      await this.#withExclusive(async () => {
        if (!this.#store.settings().enabled) return;
        if (!this.#restartRecovered) await this.#recoverRestartWork(signal);
        if (!this.#restartRecovered) return;
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
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #recoverRestartWork(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.#restartRecovered = false;
    for (const { entry, disposition } of this.#journal.listRestartWork()) {
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
        case "publish_session":
        case "delete_session":
          if (entry.scope.sessionId !== null) {
            this.#store.markHeadConflict(entry.scope.sessionId, now);
          }
          break;
        case "admit_membership_proposal":
        case "submit_enrollment":
        case "claim_enrollment":
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
      this.#lastScopeFingerprint = fingerprint;
      await this.#clearRemoteProjection();
    }
    const vault = this.#store.vault();
    return fingerprint !== null
      && (vault === null || sessionSyncHumanAuthorityMatches(vault.humanAuthority, scope));
  }

  #safeHumanScope(): SessionSyncHumanScope | null {
    try {
      return this.#humanScope();
    } catch {
      return null;
    }
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
    if (head === null || head.writerGeneration === "0") {
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
            modelEffort: localIntent.modelEffort,
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
    await this.#publishCurrentStatus();
  }

  async #acceptMembership(
    response: Extract<SessionSyncBackendResponse, { kind: "membership" }>,
    authority: SessionSyncProofAuthority,
    signal: AbortSignal,
  ): Promise<void> {
    const current = this.#store.vault();
    if (current?.membershipDigest === response.head.statementDigest) return;
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
    const pages: SessionSyncRootKeyLinkPageExchange[] = [];
    let before: PositiveSyncUint64 | undefined;
    if (keyring.currentRootKeyEpoch !== "1") {
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
              : {
                  nextBeforeChildRootKeyEpoch:
                    page.nextBeforeChildRootKeyEpoch,
                }),
          },
        });
        if (!page.hasMore) break;
        before = page.nextBeforeChildRootKeyEpoch;
      }
    }
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
        modelEffort: summary.modelEffort,
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

  async #authority(): Promise<SessionSyncProofAuthority | null> {
    const device = this.#store.device();
    const vault = this.#store.vault();
    if (
      device?.enrollmentState !== "active"
      || device.deviceId === null
      || vault?.state !== "active"
      || !sessionSyncHumanAuthorityMatches(
        vault.humanAuthority,
        this.#safeHumanScope(),
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
    if (!settings.enabled) {
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
      health: retrying || localCapacityReached ? "attention" : "current",
      retryable: retrying,
      notice: retrying
        ? "Encrypted session sync will retry without interrupting local chat."
        : localCapacityReached
          ? `This device retains ${String(localPaneBindingAdmission.bindingCount)} synced sessions. Additional panes remain local-only.`
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
