import type { Database } from "bun:sqlite";
import { isDeepStrictEqual } from "node:util";
import type {
  AccountLocalDataDeletionPreview,
  AccountSummary,
  RetainedAccountLocalData,
  RuntimeDispatchResponse,
  RuntimeDomainCommand,
  RuntimeError,
  RuntimeEvent,
  RuntimeStatus,
} from "../../../contracts/runtime";
import type {
  AccountTokenUsageState,
  AccountUsageState,
  ChatAccountRoutingCandidate,
  DispatchAccountSummary,
} from "../internal-contracts";
import type { ChatArchiveRecoveryDescriptor } from "../chat/types";
import {
  CodexRemoteResponseError,
  CodexRequestExpiredError,
  type CodexFact,
  type PinnedCodexRequestInput,
  type PinnedCodexRequestOutput,
  type PinnedCodexResponseAtPosition,
  type CodexSupervisorState,
} from "../codex";
import {
  accountPaths,
  type PortableRuntimeAssets,
  type RuntimePaths,
} from "../runtime-paths";
import type { AccountProfileFileSystem } from "./local-data-remover";
import { accountProfileLayout } from "./profile-layout";
import {
  AccountProfileCapacityExceeded,
  AccountProfileNotFound,
  AccountProfileStaleRevision,
  type AccountProfileStore,
  type StoredAccountProfile,
} from "./profile-store";
import {
  externalAuthorizationUrl,
  projectAccountRead,
  projectAccountProfileUpdated,
  projectLoginCancel,
  projectLoginCompleted,
  projectLoginStart,
  projectRateLimits,
  projectRateLimitsUpdated,
  projectTokenUsage,
  type LoginStartProjection,
} from "./protocol";
import {
  chatRoutingBudget,
  dispatchBudget,
  dispatchBudgetFreshnessMs,
  dispatchBudgetNeedsRefresh,
} from "./dispatch-budget";
import type {
  ArchiveAdmissionGate,
  AccountRemovalAdmissionHandle,
  AccountRemovalAdmissionProvisionalDescriptor,
  AccountRemovalAdmissionProvisionalHandle,
  ArchiveAdmissionDescriptor,
  ArchiveAdmissionHandle,
  ArchiveAdmissionProvisionalDescriptor,
  ArchiveAdmissionProvisionalHandle,
} from "./archive-admission-gate";
import {
  AccountRuntimeCapacityError,
  type AccountRuntimeRequestKey,
} from "./runtime-router";
import type {
  ProviderThreadArchiveJournalV57,
  ProviderThreadArchiveRecoveryInventoryV57,
  ProviderThreadArchiveTerminalCleanupComponentV57,
  ProviderThreadArchiveTerminalCleanupV57,
} from "../state/provider-thread-archive-journal-v57";

type RuntimeCommandResult = Extract<RuntimeDispatchResponse, { ok: true }>['result'];
type AccountRuntimeCommand = Extract<
  RuntimeDomainCommand,
  { readonly type: `account.${string}` | "runtime.restartAccount" }
>;
type AccountEvent = Extract<
  RuntimeEvent['event'],
  {
    type:
      | "account.upserted"
      | "account.removed"
      | "accountLocalData.upserted"
      | "accountLocalData.removed";
  }
>;

const DEFAULT_ROUTING_REFRESH_TIMEOUT_MILLISECONDS = 5_000;
const WEEKLY_USAGE_WINDOW_DURATION_MINUTES = 7 * 24 * 60;

export function accountUsageProjectionDeadline(
  usage: AccountUsageState,
): number | null {
  if (usage.state !== "ready") return null;
  const observedAt = Date.parse(usage.updatedAt);
  if (!Number.isFinite(observedAt)) return null;
  const deadlines = [observedAt + dispatchBudgetFreshnessMs];
  for (const limit of usage.limits) {
    for (const window of [limit.primary, limit.secondary]) {
      if (window?.resetsAt === null || window?.resetsAt === undefined) continue;
      const reset = Date.parse(window.resetsAt);
      if (!Number.isFinite(reset)) return null;
      deadlines.push(reset);
    }
    if (limit.individual !== null) {
      const reset = Date.parse(limit.individual.resetsAt);
      if (!Number.isFinite(reset)) return null;
      deadlines.push(reset);
    }
  }
  return Math.min(...deadlines);
}

export function accountUsageRemainingPercent(
  usage: AccountUsageState,
  nowMs: number,
): number | null {
  const deadline = accountUsageProjectionDeadline(usage);
  if (!Number.isFinite(nowMs) || deadline === null || nowMs >= deadline) return null;
  const budget = dispatchBudget(usage, nowMs);
  return budget.kind === "known"
    ? budget.remainingPercent
    : budget.kind === "exhausted"
      ? 0
      : null;
}

export function accountWeeklyUsage(
  usage: AccountUsageState,
  nowMs: number,
): AccountSummary["weeklyUsage"] {
  if (!Number.isFinite(nowMs) || usage.state !== "ready") return null;
  const codexLimit = usage.limits.find(({ id }) => id === "codex");
  const candidateLimits = codexLimit === undefined ? usage.limits : [codexLimit];
  const weeklyWindows = candidateLimits.flatMap(({ primary, secondary }) =>
    [primary, secondary].filter((window): window is NonNullable<typeof window> =>
      window !== null &&
      window.windowDurationMinutes === WEEKLY_USAGE_WINDOW_DURATION_MINUTES
    )
  );
  if (weeklyWindows.length !== 1) return null;
  const [weekly] = weeklyWindows;
  if (weekly === undefined || weekly.resetsAt === null) return null;
  const resetsAtMs = Date.parse(weekly.resetsAt);
  if (!Number.isFinite(resetsAtMs) || resetsAtMs <= nowMs) return null;
  return {
    remainingPercent: 100 - weekly.usedPercent,
    resetsAt: weekly.resetsAt,
  };
}

export interface AccountRuntimeRouterPort {
  assertArchiveTransitionQuiescent(
    accountProfileId: AccountSummary['id'],
    expectedGeneration: number,
  ): void;
  assertArchiveTransitionProvisionalReleaseSafe(
    accountProfileId: AccountSummary['id'],
    expectedGeneration: number,
  ): void;
  ensure(
    accountProfileId: AccountSummary['id'],
    paths: RuntimePaths,
    options: {
      readonly initialGeneration: number;
      readonly beforeCreate: (generation: number) => void | Promise<void>;
    },
  ): Promise<unknown>;
  ensureArchiveRecovery(
    accountProfileId: AccountSummary['id'],
    paths: RuntimePaths,
    options: {
      readonly initialGeneration: number;
      readonly beforeCreate: (generation: number) => void | Promise<void>;
    },
    archiveHandle: ArchiveAdmissionHandle,
  ): Promise<unknown>;
  request<K extends AccountRuntimeRequestKey>(
    accountProfileId: AccountSummary['id'],
    key: K,
    input: PinnedCodexRequestInput<K>,
    expectedGeneration?: number,
  ): Promise<PinnedCodexRequestOutput<K>>;
  requestWithResponsePosition<K extends AccountRuntimeRequestKey>(
    accountProfileId: AccountSummary['id'],
    key: K,
    input: PinnedCodexRequestInput<K>,
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<K>>>;
  requestArchiveRecoveryWithResponsePosition<
    K extends ChatArchiveSessionRequestKey,
  >(
    accountProfileId: AccountSummary['id'],
    archiveHandle: ArchiveAdmissionHandle,
    key: K,
    input: PinnedCodexRequestInput<K>,
    expectedGeneration: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<K>>>;
  fenceGeneration(
    accountProfileId: AccountSummary['id'],
    expectedGeneration: number,
  ): Promise<"already_fenced" | "fenced">;
  fenceAccountRemovalGeneration(
    accountProfileId: AccountSummary['id'],
    removalHandle: AccountRemovalAdmissionHandle,
  ): Promise<"already_fenced" | "fenced">;
  restart(accountProfileId: AccountSummary['id']): Promise<object | null>;
  stop(accountProfileId: AccountSummary['id']): Promise<void>;
  stopAll(): Promise<void>;
  isRunning(accountProfileId: AccountSummary['id']): boolean;
  generation(accountProfileId: AccountSummary['id']): number | null;
}

export type SessionPinnedCodexRequestKey = Extract<AccountRuntimeRequestKey,
  | "threadList"
  | "threadStart"
  | "scheduleInterpreterThreadStart"
  | "threadResume"
  | "threadArchive"
  | "threadRead"
  | "threadHistoryRead"
  | "threadTurnsList"
  | "threadItemsList"
  | "threadFork"
  | "threadGoalSet"
  | "threadGoalGet"
  | "threadGoalClear"
  | "threadSetName"
  | "threadInjectItems"
  | "modelList"
  | "configRequirementsRead"
  | "mcpServerStatusList"
  | "turnStart"
  | "turnSteer"
  | "turnInterrupt">;

type ChatArchiveSessionRequestKey = Extract<AccountRuntimeRequestKey,
  | "threadArchive"
  | "threadList">;

interface ChatArchiveRecoveryHold extends Omit<
  ChatArchiveRecoveryDescriptor,
  "restartThreadId"
> {
  readonly authorityHandle: string;
  readonly restartThreadDigest: string;
}

interface ArchiveTransitionProvisionalHoldV57
  extends ArchiveAdmissionProvisionalDescriptor {
  readonly expectedGeneration: number;
}

export interface ExternalUrlOpener {
  open(url: string): Promise<void>;
}

export interface AccountUsageProjectionScheduler {
  schedule(callback: () => void, delayMs: number): () => void;
}

export interface AccountServiceOptions {
  /** Shared router-wide provider admission authority. */
  readonly archiveAdmissionGate: ArchiveAdmissionGate;
  readonly assets: PortableRuntimeAssets;
  /**
   * Contains every chat/provider attachment binding while the profile is
   * still durably active. Removal may tombstone the profile only after this
   * idempotent join succeeds.
   */
  readonly containChatsBeforeRemoval: (
    accountProfileId: AccountSummary["id"],
  ) => Promise<void>;
  /**
   * Closed chat-side join for an approved provider-thread archive fence. The
   * account quarantine remains held until this state-only callback settles.
   */
  readonly joinChatArchiveGenerationContainment: (input: Readonly<{
    authorityHandle: string;
  }> & ChatArchiveRecoveryDescriptor) => Promise<void>;
  readonly controlPlanePath: string;
  /** Shared SQLite authority used to join profile generation and cut fencing. */
  readonly controlPlaneDatabase: Database;
  readonly emit: (event: AccountEvent) => void;
  readonly externalUrlOpener?: ExternalUrlOpener;
  readonly profileFileSystem: AccountProfileFileSystem;
  readonly providerThreadArchiveJournalV57: ProviderThreadArchiveJournalV57;
  /**
   * Bounds advisory usage refresh before routing returns its cached account
   * candidates. Provider quota proof remains the terminal admission authority.
   */
  readonly routingRefreshTimeoutMs?: number;
  readonly now?: () => Date;
  readonly router: AccountRuntimeRouterPort;
  readonly store: AccountProfileStore;
  readonly usageProjectionScheduler?: AccountUsageProjectionScheduler;
}

interface AccountEphemeralState {
  readonly login: AccountSummary['login'];
  readonly quotaProof: Readonly<{
    readonly generation: number;
    readonly streamPosition: number;
  }> | null;
  readonly rateLimitsPosition: Readonly<{
    readonly generation: number;
    readonly streamPosition: number;
  }> | null;
  readonly usageRefreshBase: Readonly<{
    readonly generation: number;
    readonly usage: Extract<AccountUsageState, { readonly state: "ready" }>;
  }> | null;
  readonly runtime: RuntimeStatus;
  readonly usage: AccountUsageState;
}

interface RateLimitReadFloor {
  readonly generation: number;
  readonly position: ResponsePosition | null;
}

interface AccountUsageRead {
  readonly observedAt: string;
  readonly rateLimits: PromiseSettledResult<
    PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<"accountRateLimitsRead">>
  >;
  readonly tokens: AccountTokenUsageState;
}

interface LoginAuthority {
  readonly authorizationUrl: string;
  readonly generation: number;
  readonly loginId: string;
  readonly mode: "browser" | "deviceCode";
}

export class AccountServiceError extends Error {
  readonly action: RuntimeError['action'];
  readonly code: RuntimeError['code'];
  readonly retryable: boolean;

  constructor(
    code: RuntimeError['code'],
    message: string,
    retryable: boolean,
    action: RuntimeError['action'],
  ) {
    super(message);
    this.name = "AccountServiceError";
    this.code = code;
    this.retryable = retryable;
    this.action = action;
  }
}

export class MacOsExternalUrlOpener implements ExternalUrlOpener {
  async open(url: string): Promise<void> {
    const safeUrl = externalAuthorizationUrl(url);
    const child = Bun.spawn(["/usr/bin/open", safeUrl], {
      env: { PATH: "/usr/bin:/bin" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    if (await child.exited !== 0) {
      throw new AccountServiceError(
        "operation_failed",
        "The sign-in page could not be opened.",
        true,
        "retry",
      );
    }
  }
}

export class AccountService {
  readonly #archiveAdmissionGate: ArchiveAdmissionGate;
  readonly #assets: PortableRuntimeAssets;
  readonly #containChatsBeforeRemoval: AccountServiceOptions[
    "containChatsBeforeRemoval"
  ];
  readonly #joinChatArchiveGenerationContainment: AccountServiceOptions[
    "joinChatArchiveGenerationContainment"
  ];
  readonly #controlPlanePath: string;
  readonly #controlPlaneDatabase: Database;
  readonly #emit: (event: AccountEvent) => void;
  readonly #ephemeral = new Map<string, AccountEphemeralState>();
  readonly #externalUrlOpener: ExternalUrlOpener;
  readonly #loginAuthorities = new Map<string, LoginAuthority>();
  readonly #profileFileSystem: AccountProfileFileSystem;
  readonly #providerThreadArchiveJournalV57: ProviderThreadArchiveJournalV57;
  readonly #containmentFlights = new Map<string, Readonly<{
    generation: number;
    promise: Promise<number>;
  }>>();
  readonly #archiveContainmentFlights = new Map<string, Readonly<{
    accountProfileId: string;
    authorityHandle: string;
    promise: Promise<void>;
  }>>();
  readonly #archiveContainmentTails = new Map<string, Promise<void>>();
  readonly #archiveRecoveryHoldByPane = new Map<string, string>();
  readonly #archiveRecoveryHolds = new Map<string, ChatArchiveRecoveryHold>();
  readonly #archiveTransitionHandlesV57 = new Map<
    string,
    ArchiveAdmissionHandle
  >();
  readonly #releasedArchiveTransitionHandlesV57 = new WeakMap<
    ArchiveAdmissionHandle,
    string
  >();
  readonly #archiveTransitionProvisionalsV57 = new WeakMap<
    ArchiveAdmissionProvisionalHandle,
    ArchiveTransitionProvisionalHoldV57
  >();
  readonly #accountRemovalHandlesV57 = new Map<
    string,
    AccountRemovalAdmissionHandle
  >();
  readonly #accountRemovalProvisionalsV57 = new WeakMap<
    AccountRemovalAdmissionProvisionalHandle,
    AccountRemovalAdmissionProvisionalDescriptor
  >();
  readonly #mutationTails = new Map<string, Promise<void>>();
  readonly #quarantinedGenerations = new Map<string, number>();
  readonly #now: () => Date;
  readonly #reconcileOnRunning = new Set<string>();
  readonly #routingRefreshTimeoutMs: number;
  readonly #router: AccountRuntimeRouterPort;
  readonly #store: AccountProfileStore;
  readonly #usageExpiryTimers = new Map<string, Readonly<{
    cancel: () => void;
    usageUpdatedAt: string;
  }>>();
  readonly #usageProjectionScheduler: AccountUsageProjectionScheduler;
  #archiveAdmissionReplayInstalled = false;
  #shuttingDown = false;

  constructor(options: AccountServiceOptions) {
    this.#archiveAdmissionGate = options.archiveAdmissionGate;
    this.#assets = options.assets;
    this.#containChatsBeforeRemoval = options.containChatsBeforeRemoval;
    this.#joinChatArchiveGenerationContainment =
      options.joinChatArchiveGenerationContainment;
    this.#controlPlanePath = options.controlPlanePath;
    this.#controlPlaneDatabase = options.controlPlaneDatabase;
    this.#emit = options.emit;
    this.#externalUrlOpener = options.externalUrlOpener ?? new MacOsExternalUrlOpener();
    this.#profileFileSystem = options.profileFileSystem;
    this.#providerThreadArchiveJournalV57 =
      options.providerThreadArchiveJournalV57;
    this.#routingRefreshTimeoutMs = positiveRoutingRefreshTimeout(
      options.routingRefreshTimeoutMs ?? DEFAULT_ROUTING_REFRESH_TIMEOUT_MILLISECONDS,
    );
    this.#now = options.now ?? (() => new Date());
    this.#router = options.router;
    this.#store = options.store;
    this.#usageProjectionScheduler = options.usageProjectionScheduler ?? {
      schedule: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      },
    };
  }

  /** Reconstructs every keyed durable v57 hold before account initialization. */
  installArchiveAdmissionReplayV57(
    expected?: ProviderThreadArchiveRecoveryInventoryV57,
  ): ProviderThreadArchiveRecoveryInventoryV57 {
    if (this.#archiveAdmissionReplayInstalled) {
      throw new Error("Provider archive admission replay was already installed");
    }
    const input = this.#providerThreadArchiveJournalV57.recoveryInventory();
    if (expected !== undefined && !isDeepStrictEqual(input, expected)) {
      throw new Error(
        "Provider archive admission replay does not match the verified recovery inventory",
      );
    }
    const installedTransitions: Array<Readonly<{
      transitionId: string;
      handle: ArchiveAdmissionHandle;
    }>> = [];
    const installedRemovals: Array<Readonly<{
      transitionId: string;
      handle: AccountRemovalAdmissionHandle;
    }>> = [];
    try {
      for (const descriptor of input.admissionDescriptors) {
        if (this.#archiveTransitionHandlesV57.has(descriptor.transitionId)) {
          throw new Error("Provider archive replay contains a duplicate transition");
        }
        const handle = this.#archiveAdmissionGate.retain(descriptor);
        this.#archiveTransitionHandlesV57.set(descriptor.transitionId, handle);
        installedTransitions.push({ transitionId: descriptor.transitionId, handle });
      }
      for (const descriptor of input.removalAdmissionDescriptors) {
        if (this.#accountRemovalHandlesV57.has(descriptor.transitionId)) {
          throw new Error("Provider archive replay contains a duplicate account removal");
        }
        const handle = this.#archiveAdmissionGate.retainAccountRemoval(descriptor);
        this.#accountRemovalHandlesV57.set(descriptor.transitionId, handle);
        installedRemovals.push({ transitionId: descriptor.transitionId, handle });
      }
      this.#archiveAdmissionReplayInstalled = true;
      return input;
    } catch (error: unknown) {
      for (const installed of installedRemovals.reverse()) {
        this.#accountRemovalHandlesV57.delete(installed.transitionId);
        this.#archiveAdmissionGate.releaseAccountRemoval(installed.handle);
      }
      for (const installed of installedTransitions.reverse()) {
        this.#archiveTransitionHandlesV57.delete(installed.transitionId);
        this.#archiveAdmissionGate.release(installed.handle);
      }
      throw error;
    }
  }

  archiveTransitionHandleV57(transitionId: string): ArchiveAdmissionHandle {
    const handle = this.#archiveTransitionHandlesV57.get(transitionId);
    if (handle === undefined) {
      throw new AccountServiceError(
        "conflict",
        "The provider archive recovery authority is unavailable.",
        false,
        "none",
      );
    }
    return handle;
  }

  accountRemovalHandleV57(transitionId: string): AccountRemovalAdmissionHandle {
    const handle = this.#accountRemovalHandlesV57.get(transitionId);
    if (handle === undefined) {
      throw new AccountServiceError(
        "conflict",
        "The account-removal recovery authority is unavailable.",
        false,
        "none",
      );
    }
    return handle;
  }

  initialize(): Promise<readonly AccountSummary[]> {
    if (!this.#archiveAdmissionReplayInstalled) {
      throw new Error(
        "Provider archive admission replay must complete before account initialization",
      );
    }
    const storedProfiles = this.#store.list();
    const preparations: Array<Readonly<{
      profileId: string;
      reconcileRuntime: boolean;
      refreshUsage: boolean;
      resumeLogout: boolean;
    }>> = [];
    const accounts = storedProfiles.map((stored) => {
      let profile = stored;
      if (this.#archiveAdmissionGate.isHeld(profile.id)) {
        return this.#publish(profile);
      }
      let reconcileRuntime = false;
      const resumeLogout = profile.authState === "signingOut";
      if (isTransientAuthState(profile.authState) && !resumeLogout) {
        profile = this.#store.updateAuthState(profile.id, "unknown", this.#now());
        this.#setEphemeral(profile.id, {
          ...this.#ephemeralFor(profile),
          login: {
            state: "failed",
            message: "Sign-in state is being reconciled after HRA restarted.",
          },
        });
        this.#reconcileOnRunning.add(profile.id);
        reconcileRuntime = true;
      }
      const account = this.#publish(profile);
      preparations.push({
        profileId: profile.id,
        reconcileRuntime,
        refreshUsage: profile.authState === "signedIn",
        resumeLogout,
      });
      return account;
    });
    for (const profile of this.#store.listRetainedLocalData()) {
      this.#emit({ type: "accountLocalData.upserted", localData: retainedLocalData(profile) });
    }
    void this.#prepareStoredProfiles(preparations).catch(() => undefined);
    return Promise.resolve(accounts);
  }

  async #prepareStoredProfiles(
    preparations: readonly Readonly<{
      profileId: string;
      reconcileRuntime: boolean;
      refreshUsage: boolean;
      resumeLogout: boolean;
    }>[],
  ): Promise<void> {
    for (const preparation of preparations) {
      if (this.#shuttingDown) return;
      if (this.#archiveAdmissionGate.isHeld(preparation.profileId)) continue;
      await this.#serialize(preparation.profileId, async () => {
        try {
          this.#assertOrdinaryArchiveAdmission(preparation.profileId);
          await this.#profileFileSystem.ensureAccountProfile(preparation.profileId);
          this.#assertOrdinaryArchiveAdmission(preparation.profileId);
          if (preparation.resumeLogout) {
            await this.#finishPendingLogout(preparation.profileId, true);
            return;
          }
          if (preparation.reconcileRuntime) {
            await this.#ensureRuntime(
              this.#requireActive(preparation.profileId),
              true,
            );
          }
          if (preparation.refreshUsage) {
            try {
              await this.#refreshDispatchAccount(
                this.#requireActive(preparation.profileId),
              );
            } catch {
              // Startup usage is advisory. The refresh path has already
              // published an explicit unknown state, while the signed-in
              // profile remains usable for provider admission.
            }
          }
        } catch {
          if (this.#archiveAdmissionGate.isHeld(preparation.profileId)) return;
          const current = this.#store.find(preparation.profileId);
          if (current === null || this.#shuttingDown) return;
          if (preparation.resumeLogout && current.authState === "signingOut") {
            this.#publish(current);
            return;
          }
          const updated = this.#store.bumpRevision(preparation.profileId, this.#now());
          this.#setEphemeral(preparation.profileId, {
            ...this.#ephemeralFor(updated),
            runtime: {
              state: "failed",
              generation: updated.processGeneration,
              message: "This account's local storage could not be prepared.",
              canRestart: true,
            },
          });
          this.#publish(updated);
        }
      });
      // Admit foreground account work between best-effort startup checks.
      await Bun.sleep(0);
    }
  }

  execute(command: AccountRuntimeCommand): Promise<RuntimeCommandResult> {
    const accountProfileId = commandAccountProfileId(command);
    if (accountProfileId === null) return this.#executeUnserialized(command);
    try {
      this.#assertOrdinaryArchiveAdmission(accountProfileId);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error ? error : new Error("Account admission failed"),
      );
    }
    return this.#serialize(accountProfileId, () => {
      this.#assertOrdinaryArchiveAdmission(accountProfileId);
      return this.#executeUnserialized(command);
    });
  }

  /**
   * Gives product-owned runtime services access to this account's isolated
   * app-server without exposing process paths or generation bookkeeping.
   * Callers can invoke only the closed set of pinned session operations.
   */
  requestSession<K extends SessionPinnedCodexRequestKey>(
    accountProfileId: AccountSummary['id'],
    key: K,
    input: PinnedCodexRequestInput<K>,
    expectedGeneration?: number,
  ): Promise<PinnedCodexRequestOutput<K>> {
    return this.#requestSession(accountProfileId, async () =>
      await this.#router.request(accountProfileId, key, input, expectedGeneration));
  }

  requestSessionWithResponsePosition<K extends SessionPinnedCodexRequestKey>(
    accountProfileId: AccountSummary['id'],
    key: K,
    input: PinnedCodexRequestInput<K>,
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<K>>> {
    return this.#requestSession(accountProfileId, async () =>
      await this.#router.requestWithResponsePosition(
        accountProfileId,
        key,
        input,
        expectedGeneration,
      ));
  }

  /**
   * Opaque, router-enforced provider archive recovery lane. The handle is
   * memory-only authority issued from a keyed durable v57 journal snapshot.
   */
  requestArchiveRecoveryWithResponsePosition<
    K extends ChatArchiveSessionRequestKey,
  >(
    accountProfileId: AccountSummary['id'],
    archiveHandle: ArchiveAdmissionHandle,
    key: K,
    input: PinnedCodexRequestInput<K>,
    expectedGeneration: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<K>>> {
    try {
      this.#requireJournaledArchiveAdmission(archiveHandle, accountProfileId);
    } catch (error: unknown) {
      return Promise.reject(this.#archiveAdmissionError(error));
    }
    return this.#serialize(accountProfileId, async () => {
      const profile = this.#requireSignedInForArchiveRecovery(accountProfileId);
      this.#requireJournaledArchiveAdmission(archiveHandle, accountProfileId);
      await this.#ensureRuntime(profile, false, archiveHandle);
      this.#requireJournaledArchiveAdmission(archiveHandle, accountProfileId);
      try {
        const response = await this.#router.requestArchiveRecoveryWithResponsePosition(
          accountProfileId,
          archiveHandle,
          key,
          input,
          expectedGeneration,
        );
        this.#requireJournaledArchiveAdmission(archiveHandle, accountProfileId);
        return response;
      } catch (error: unknown) {
        if (this.#expireInvalidAuthentication(accountProfileId, error)) {
          throw new AccountServiceError(
            "capability_unavailable",
            "This Codex session expired. Sign in again before continuing.",
            false,
            "signIn",
          );
        }
        throw serviceError(error);
      }
    });
  }

  ensureArchiveRecoveryRuntime(
    accountProfileId: AccountSummary['id'],
    archiveHandle: ArchiveAdmissionHandle,
  ): Promise<Readonly<{ generation: number }>> {
    try {
      this.#requireJournaledArchiveAdmission(archiveHandle, accountProfileId);
    } catch (error: unknown) {
      return Promise.reject(this.#archiveAdmissionError(error));
    }
    return this.#serialize(accountProfileId, async () => {
      const profile = this.#requireSignedInForArchiveRecovery(accountProfileId);
      this.#requireJournaledArchiveAdmission(archiveHandle, accountProfileId);
      await this.#ensureRuntime(profile, false, archiveHandle);
      this.#requireJournaledArchiveAdmission(archiveHandle, accountProfileId);
      const current = this.#requireActive(accountProfileId);
      const generation = this.#router.generation(accountProfileId);
      if (
        generation === null || !this.#router.isRunning(accountProfileId) ||
        generation !== current.processGeneration
      ) {
        throw new AccountServiceError(
          "runtime_unavailable",
          "The Codex archive recovery runtime did not converge to its durable generation.",
          true,
          "restartRuntime",
        );
      }
      return Object.freeze({ generation });
    });
  }

  /**
   * Re-establishes same-process lineage for one crash-replayed, durably
   * contained not-applied attempt. The exact N+1 runtime is converged through
   * the closed recovery lane first. Activation itself grants no mutation;
   * only a later atomic journal advance to effect_started can create the
   * one-shot archive claim.
   */
  activateArchiveTransitionSuccessorV57(input: Readonly<{
    accountProfileId: AccountSummary['id'];
    transitionId: string;
    archiveHandle: ArchiveAdmissionHandle;
  }>): Promise<Readonly<{
    archiveHandle: ArchiveAdmissionHandle;
    generation: number;
  }>> {
    const { accountProfileId, transitionId } = input;
    try {
      if (
        this.#archiveTransitionHandlesV57.get(transitionId) !==
          input.archiveHandle
      ) {
        throw new AccountServiceError(
          "conflict",
          "The provider archive successor activation authority changed.",
          false,
          "none",
        );
      }
      this.#requireJournaledArchiveAdmission(
        input.archiveHandle,
        accountProfileId,
      );
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof AccountServiceError
          ? error
          : this.#archiveAdmissionError(error),
      );
    }
    return this.#serialize(accountProfileId, async () => {
      const descriptor = this.#requireJournaledArchiveAdmission(
        input.archiveHandle,
        accountProfileId,
      );
      const target = this.#providerThreadArchiveJournalV57.reopenTarget(
        transitionId,
      );
      const cutId = target.currentAttempt.cutId;
      if (cutId === null) {
        throw new AccountServiceError(
          "conflict",
          "The provider archive successor lacks its contained cut.",
          false,
          "none",
        );
      }
      const cut = this.#providerThreadArchiveJournalV57.reopenCut(cutId);
      if (
        descriptor.transitionId !== transitionId ||
        descriptor.attemptPhase !== "reconciled_not_applied" ||
        descriptor.cutAuthority === null ||
        descriptor.successorGeneration === null ||
        target.status !== "open" ||
        target.currentAttempt.state !== "reconciled_not_applied" ||
        target.currentAttempt.generation !== descriptor.expectedGeneration ||
        cut.accountProfileId !== accountProfileId ||
        cut.sourceGeneration !== descriptor.expectedGeneration ||
        cut.successorGeneration !== descriptor.successorGeneration ||
        cut.state !== "contained" ||
        cut.cause === "account_removal"
      ) {
        throw new AccountServiceError(
          "conflict",
          "The provider archive attempt is not an exact contained successor.",
          false,
          "none",
        );
      }

      const profile = this.#requireSignedInForArchiveRecovery(accountProfileId);
      this.#assertArchiveRecoveryProfilePostimage(profile, descriptor);
      await this.#ensureRuntime(profile, false, input.archiveHandle);

      if (this.#shuttingDown) {
        throw new AccountServiceError(
          "runtime_unavailable",
          "The local account service shut down before successor activation.",
          false,
          "none",
        );
      }

      const currentDescriptor = this.#requireJournaledArchiveAdmission(
        input.archiveHandle,
        accountProfileId,
      );
      if (!isDeepStrictEqual(currentDescriptor, descriptor)) {
        throw new AccountServiceError(
          "conflict",
          "The provider archive successor authority changed during recovery launch.",
          false,
          "none",
        );
      }
      const currentProfile = this.#requireSignedInForArchiveRecovery(
        accountProfileId,
      );
      this.#assertArchiveRecoveryProfilePostimage(currentProfile, descriptor);
      const generation = this.#router.generation(accountProfileId);
      if (
        generation !== descriptor.successorGeneration ||
        !this.#router.isRunning(accountProfileId)
      ) {
        throw new AccountServiceError(
          "runtime_unavailable",
          "The provider archive successor runtime did not converge exactly.",
          true,
          "restartRuntime",
        );
      }

      const archiveHandle = this.#archiveAdmissionGate
        .activateContainedSuccessor(input.archiveHandle);
      this.#archiveTransitionHandlesV57.set(transitionId, archiveHandle);
      return Object.freeze({ archiveHandle, generation });
    });
  }

  /**
   * Fences an ambiguous source generation, then atomically reserves its exact
   * successor in the account profile and the keyed v57 cut. The in-memory
   * handle advances only after that SQLite transaction commits, so restart
   * replay observes either the old cut or the complete successor authority.
   */
  containArchiveTransitionGenerationV57(input: Readonly<{
    accountProfileId: AccountSummary['id'];
    transitionId: string;
    cutId: string;
    archiveHandle: ArchiveAdmissionHandle;
  }>): Promise<Readonly<{
    accountProfileRevision: number;
    archiveHandle: ArchiveAdmissionHandle;
    generation: number;
  }>> {
    const accountProfileId = input.accountProfileId;
    try {
      if (
        this.#archiveTransitionHandlesV57.get(input.transitionId) !==
          input.archiveHandle
      ) {
        throw new AccountServiceError(
          "conflict",
          "The provider archive recovery authority changed before fencing.",
          false,
          "none",
        );
      }
      this.#requireJournaledArchiveAdmission(
        input.archiveHandle,
        accountProfileId,
      );
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof AccountServiceError
          ? error
          : this.#archiveAdmissionError(error),
      );
    }
    return this.#serialize(accountProfileId, async () => {
      let descriptor = this.#requireJournaledArchiveAdmission(
        input.archiveHandle,
        accountProfileId,
      );
      const target = this.#providerThreadArchiveJournalV57.reopenTarget(
        input.transitionId,
      );
      const cut = this.#providerThreadArchiveJournalV57.reopenCut(input.cutId);
      if (
        descriptor.transitionId !== input.transitionId ||
        descriptor.attemptPhase !== "ambiguous" ||
        descriptor.cutAuthority === null ||
        descriptor.successorGeneration !== null ||
        target.currentAttempt.cutId !== input.cutId ||
        target.currentAttempt.generation !== descriptor.expectedGeneration ||
        cut.accountProfileId !== accountProfileId ||
        cut.sourceGeneration !== descriptor.expectedGeneration ||
        cut.successorGeneration !== null ||
        cut.state !== "fence_started"
      ) {
        throw new AccountServiceError(
          "conflict",
          "The provider archive attempt is not ready for exact-generation containment.",
          false,
          "none",
        );
      }
      this.#bindArchiveCutTargetsBeforeFence(cut);
      descriptor = this.#requireJournaledArchiveAdmission(
        input.archiveHandle,
        accountProfileId,
      );
      const profileBeforeFence = this.#requireSignedInForArchiveRecovery(
        accountProfileId,
      );
      this.#assertArchiveRecoveryProfilePostimage(
        profileBeforeFence,
        descriptor,
      );
      const fenceDisposition = await this.#router.fenceGeneration(
        accountProfileId,
        descriptor.expectedGeneration,
      );
      this.#requireJournaledArchiveAdmission(
        input.archiveHandle,
        accountProfileId,
      );

      const successorGeneration = descriptor.expectedGeneration + 1;
      if (!Number.isSafeInteger(successorGeneration)) {
        throw new AccountServiceError(
          "conflict",
          "The provider archive successor generation exceeds its durable bound.",
          false,
          "none",
        );
      }
      const now = this.#now();
      const committed = this.#controlPlaneDatabase.transaction(() => {
        const current = this.#requireSignedInForArchiveRecovery(accountProfileId);
        this.#assertArchiveRecoveryProfilePostimage(current, descriptor);
        if (current.processGeneration !== descriptor.expectedGeneration) {
          throw new AccountServiceError(
            "conflict",
            "The provider archive account generation changed before its fence committed.",
            false,
            "none",
          );
        }
        const generationUpdate = this.#store.updateProcessGeneration(
          accountProfileId,
          successorGeneration,
          now,
        );
        if (
          !generationUpdate.advanced ||
          generationUpdate.profile.processGeneration !== successorGeneration
        ) {
          throw new AccountServiceError(
            "conflict",
            "The provider archive successor generation was not claimed exactly once.",
            false,
            "none",
          );
        }
        this.#providerThreadArchiveJournalV57.recordFence({
          cutId: input.cutId,
          successorGeneration,
          successorAccountProfileRevision: generationUpdate.profile.revision,
          fenceEvidenceDigest: providerArchiveEvidenceDigestV57(
            "generation-fence",
            {
              accountProfileId,
              cutId: input.cutId,
              disposition: fenceDisposition,
              sourceGeneration: descriptor.expectedGeneration,
              successorGeneration,
              transitionId: input.transitionId,
            },
          ),
          fenceRevisionDigest: providerArchiveEvidenceDigestV57(
            "generation-fence-revision",
            {
              accountProfileId,
              accountProfileRevision: generationUpdate.profile.revision,
              processGeneration: generationUpdate.profile.processGeneration,
            },
          ),
          now,
        });
        return generationUpdate.profile;
      }).immediate();
      const advancedHandles = this.#advanceArchiveCutHandlesFromJournal(
        input.cutId,
      );
      const archiveHandle = advancedHandles.get(input.transitionId);
      if (archiveHandle === undefined) {
        throw new AccountServiceError(
          "conflict",
          "The contained provider archive cut lost its initiating target hold.",
          false,
          "none",
        );
      }
      this.#publish(committed);
      return Object.freeze({
        accountProfileRevision: committed.revision,
        archiveHandle,
        generation: successorGeneration,
      });
    });
  }

  fenceAccountRemovalGeneration(
    accountProfileId: AccountSummary['id'],
    removalHandle: AccountRemovalAdmissionHandle,
  ): Promise<"already_fenced" | "fenced"> {
    try {
      this.#archiveAdmissionGate.requireAccountRemoval(
        removalHandle,
        accountProfileId,
      );
    } catch (error: unknown) {
      return Promise.reject(this.#archiveAdmissionError(error));
    }
    return this.#serialize(accountProfileId, async () => {
      this.#archiveAdmissionGate.requireAccountRemoval(
        removalHandle,
        accountProfileId,
      );
      const result = await this.#router.fenceAccountRemovalGeneration(
        accountProfileId,
        removalHandle,
      );
      this.#archiveAdmissionGate.requireAccountRemoval(
        removalHandle,
        accountProfileId,
      );
      return result;
    });
  }

  ordinaryAdmissionAvailable(accountProfileId: AccountSummary['id']): boolean {
    return !this.#archiveAdmissionGate.isHeld(accountProfileId);
  }

  beginArchiveTransitionProvisional(
    descriptor: ArchiveAdmissionProvisionalDescriptor,
  ): Promise<Readonly<{
    generation: number;
    handle: ArchiveAdmissionProvisionalHandle;
  }>> {
    return this.#serialize(descriptor.accountProfileId, async () => {
      this.#assertOrdinaryArchiveAdmission(descriptor.accountProfileId);
      const profile = this.#requireSignedInForArchiveRecovery(
        descriptor.accountProfileId,
      );
      await this.#ensureRuntime(profile);
      this.#assertOrdinaryArchiveAdmission(descriptor.accountProfileId);
      const current = this.#requireActive(descriptor.accountProfileId);
      const generation = this.#router.generation(descriptor.accountProfileId);
      if (
        generation === null || !this.#router.isRunning(descriptor.accountProfileId) ||
        generation !== current.processGeneration
      ) {
        throw new AccountServiceError(
          "runtime_unavailable",
          "The provider runtime did not converge before archive quarantine.",
          true,
          "restartRuntime",
        );
      }
      // This assertion and provisional retain intentionally share one
      // synchronous JavaScript turn. Once the hold lands, every ordinary
      // router entry closes, so no provider work can enter between them.
      this.#router.assertArchiveTransitionQuiescent(
        descriptor.accountProfileId,
        generation,
      );
      const handle = this.#archiveAdmissionGate.retainProvisional(descriptor);
      this.#archiveTransitionProvisionalsV57.set(handle, Object.freeze({
        accountProfileId: descriptor.accountProfileId,
        expectedGeneration: generation,
        paneId: descriptor.paneId,
        purpose: descriptor.purpose,
        transitionId: descriptor.transitionId,
      }));
      return Object.freeze({ generation, handle });
    });
  }

  promoteArchiveTransition(
    provisionalHandle: ArchiveAdmissionProvisionalHandle,
    transitionId: string,
  ): ArchiveAdmissionHandle {
    const provisional = this.#requireArchiveTransitionProvisional(
      provisionalHandle,
      transitionId,
    );
    const descriptor = this.#providerThreadArchiveJournalV57.admissionDescriptor(
      transitionId,
    );
    if (descriptor.accountProfileId !== provisional.accountProfileId) {
      throw new AccountServiceError(
        "conflict",
        "The durable provider archive target belongs to a different account.",
        false,
        "none",
      );
    }
    if (this.#archiveTransitionHandlesV57.has(descriptor.transitionId)) {
      throw new AccountServiceError(
        "conflict",
        "This provider archive transition already has recovery authority.",
        false,
        "none",
      );
    }
    const handle = this.#archiveAdmissionGate.promote(
      provisionalHandle,
      descriptor,
    );
    this.#archiveTransitionHandlesV57.set(descriptor.transitionId, handle);
    this.#archiveTransitionProvisionalsV57.delete(provisionalHandle);
    return handle;
  }

  promoteArchiveTransitionEffectStarted(
    provisionalHandle: ArchiveAdmissionProvisionalHandle,
    transitionId: string,
  ): ArchiveAdmissionHandle {
    const provisional = this.#requireArchiveTransitionProvisional(
      provisionalHandle,
      transitionId,
    );
    const descriptor = this.#providerThreadArchiveJournalV57.admissionDescriptor(
      transitionId,
    );
    if (descriptor.accountProfileId !== provisional.accountProfileId) {
      throw new AccountServiceError(
        "conflict",
        "The durable provider archive target belongs to a different account.",
        false,
        "none",
      );
    }
    if (this.#archiveTransitionHandlesV57.has(descriptor.transitionId)) {
      throw new AccountServiceError(
        "conflict",
        "This provider archive transition already has recovery authority.",
        false,
        "none",
      );
    }
    const handle = this.#archiveAdmissionGate.promoteEffectStarted(
      provisionalHandle,
      descriptor,
    );
    this.#archiveTransitionHandlesV57.set(descriptor.transitionId, handle);
    this.#archiveTransitionProvisionalsV57.delete(provisionalHandle);
    return handle;
  }

  replaceArchiveTransition(
    predecessor: ArchiveAdmissionHandle,
    transitionId: string,
  ): ArchiveAdmissionHandle {
    const descriptor = this.#providerThreadArchiveJournalV57.admissionDescriptor(
      transitionId,
    );
    if (
      this.#archiveTransitionHandlesV57.get(descriptor.transitionId) !==
        predecessor
    ) {
      throw new AccountServiceError(
        "conflict",
        "The provider archive recovery authority changed.",
        false,
        "none",
      );
    }
    const handle = this.#archiveAdmissionGate.replace(predecessor, descriptor);
    this.#archiveTransitionHandlesV57.set(descriptor.transitionId, handle);
    return handle;
  }

  /**
   * Gaplessly refreshes every target authority carried by one durable cut.
   *
   * Cut binding, fencing, inventory sealing, member settlement, and final
   * containment all advance the keyed cut authority shared by every target.
   * The coordinator must call this immediately after each such committed
   * journal mutation, before using any target's recovery handle again.
   */
  refreshArchiveTransitionCutAuthoritiesV57(input: Readonly<{
    archiveHandle: ArchiveAdmissionHandle;
    cutId: string;
    transitionId: string;
  }>): ArchiveAdmissionHandle {
    if (
      this.#archiveTransitionHandlesV57.get(input.transitionId) !==
        input.archiveHandle
    ) {
      throw new AccountServiceError(
        "conflict",
        "The provider archive cut refresh authority changed.",
        false,
        "none",
      );
    }
    const observed = this.#archiveAdmissionGate.require(input.archiveHandle);
    const target = this.#providerThreadArchiveJournalV57.reopenTarget(
      input.transitionId,
    );
    const cut = this.#providerThreadArchiveJournalV57.reopenCut(input.cutId);
    if (
      observed.transitionId !== input.transitionId ||
      target.currentAttempt.cutId !== input.cutId ||
      observed.accountProfileId !== cut.accountProfileId
    ) {
      throw new AccountServiceError(
        "conflict",
        "The provider archive cut no longer owns the initiating transition.",
        false,
        "none",
      );
    }
    const advanced = this.#advanceArchiveCutHandlesFromJournal(input.cutId);
    const initiating = advanced.get(input.transitionId);
    if (initiating === undefined) {
      throw new AccountServiceError(
        "conflict",
        "The provider archive cut lost its initiating transition authority.",
        false,
        "none",
      );
    }
    return initiating;
  }

  releaseArchiveTransition(
    transitionId: string,
    handle: ArchiveAdmissionHandle,
    expectedComponent: ProviderThreadArchiveTerminalCleanupComponentV57,
  ): ProviderThreadArchiveTerminalCleanupV57 {
    if (this.#archiveTransitionHandlesV57.get(transitionId) !== handle) {
      if (
        this.#releasedArchiveTransitionHandlesV57.get(handle) === transitionId
      ) {
        return emptyProviderThreadArchiveTerminalCleanupV57();
      }
      throw new AccountServiceError(
        "conflict",
        "A stale provider archive authority cannot release its successor.",
        false,
        "none",
      );
    }
    const admission = this.#archiveAdmissionGate.require(handle);
    if (admission.transitionId !== transitionId) {
      throw new AccountServiceError(
        "conflict",
        "A provider archive release crossed its durable transition authority.",
        false,
        "none",
      );
    }
    // ChatService reaches this seam with the exact terminal component panes
    // already drained. This synchronous proof, journal cleanup, and Gate
    // release have no async boundary, so a foreign callback cannot enter
    // between the final generation check and admission reopening.
    this.#router.assertArchiveTransitionProvisionalReleaseSafe(
      admission.accountProfileId,
      admission.successorGeneration ?? admission.expectedGeneration,
    );
    const release = this.#controlPlaneDatabase.transaction(() => {
      const target = this.#providerThreadArchiveJournalV57.reopenTarget(
        transitionId,
      );
      if (target.status !== "committed") {
        throw new AccountServiceError(
          "conflict",
          "Provider archive admission remains held until its local pane commit is durable.",
          false,
          "none",
        );
      }
      const observedComponent = this.#providerThreadArchiveJournalV57
        .terminalCleanupComponent(transitionId);
      if (!isDeepStrictEqual(expectedComponent, observedComponent)) {
        throw new AccountServiceError(
          "conflict",
          "Provider archive terminal cleanup authority changed.",
          false,
          "none",
        );
      }
      for (const componentTargetId of observedComponent.targetIds) {
        if (componentTargetId === transitionId) continue;
        const peerHandle = this.#archiveTransitionHandlesV57.get(
          componentTargetId,
        );
        if (peerHandle !== undefined) continue;
        const peer = this.#providerThreadArchiveJournalV57.reopenTarget(
          componentTargetId,
        );
        if (peer.status !== "committed") {
          throw new AccountServiceError(
            "conflict",
            "A provider archive component lost its active admission authority.",
            false,
            "none",
          );
        }
      }
      if (!observedComponent.allTargetsCommitted) {
        return Object.freeze({
          cleanup: emptyProviderThreadArchiveTerminalCleanupV57(),
          releasedHandles: Object.freeze([[transitionId, handle]] as const),
        });
      }

      const deleted = this.#providerThreadArchiveJournalV57
        .deleteCommittedTargetSafely(transitionId, expectedComponent);
      const expectedCleanup = Object.freeze({
        deletedTargetIds: observedComponent.targetIds,
        deletedCutIds: observedComponent.cutIds,
      });
      if (!isDeepStrictEqual(deleted, expectedCleanup)) {
        throw new AccountServiceError(
          "conflict",
          "Provider archive terminal cleanup did not remove the exact component.",
          false,
          "none",
        );
      }
      const componentHandles: Array<readonly [string, ArchiveAdmissionHandle]> = [];
      for (const deletedTargetId of deleted.deletedTargetIds) {
        const componentHandle = this.#archiveTransitionHandlesV57.get(
          deletedTargetId,
        );
        if (componentHandle !== undefined) {
          componentHandles.push([deletedTargetId, componentHandle]);
        }
      }
      if (!componentHandles.some(([targetId, componentHandle]) =>
        targetId === transitionId && componentHandle === handle
      )) {
        throw new AccountServiceError(
          "conflict",
          "Provider archive terminal cleanup lost its releasing authority.",
          false,
          "none",
        );
      }
      return Object.freeze({
        cleanup: deleted,
        releasedHandles: Object.freeze(componentHandles),
      });
    })();
    for (const [releasedTransitionId, releasedHandle] of release.releasedHandles) {
      this.#archiveAdmissionGate.release(releasedHandle);
      this.#archiveTransitionHandlesV57.delete(releasedTransitionId);
      this.#releasedArchiveTransitionHandlesV57.set(
        releasedHandle,
        releasedTransitionId,
      );
    }
    return release.cleanup;
  }

  abortArchiveTransitionProvisional(
    handle: ArchiveAdmissionProvisionalHandle,
  ): Promise<void> {
    let descriptor: ArchiveTransitionProvisionalHoldV57;
    try {
      descriptor = this.#requireArchiveTransitionProvisional(handle);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new Error("Provider archive provisional admission failed"),
      );
    }
    return this.#serialize(descriptor.accountProfileId, async () => {
      let current = this.#requireArchiveTransitionProvisional(handle);
      this.#assertArchiveTransitionProvisionalIsNotDurable(current.transitionId);
      try {
        this.#router.assertArchiveTransitionProvisionalReleaseSafe(
          current.accountProfileId,
          current.expectedGeneration,
        );
      } catch {
        // A callback suppressed by the provisional hold invalidates the live
        // generation's no-work proof. Keep the hold installed while stopping
        // only that source generation; no successor is started here.
        await this.#router.fenceGeneration(
          current.accountProfileId,
          current.expectedGeneration,
        );
        current = this.#requireArchiveTransitionProvisional(handle);
        this.#assertArchiveTransitionProvisionalIsNotDurable(
          current.transitionId,
        );
        this.#router.assertArchiveTransitionProvisionalReleaseSafe(
          current.accountProfileId,
          current.expectedGeneration,
        );
      }
      // The final durable and terminal checks share one synchronous turn with
      // release. A promotion cannot interleave after these proofs.
      this.#assertArchiveTransitionProvisionalIsNotDurable(current.transitionId);
      this.#archiveAdmissionGate.abortProvisional(handle);
      this.#archiveTransitionProvisionalsV57.delete(handle);
    });
  }

  retainAccountRemovalProvisional(
    accountProfileId: AccountSummary['id'],
    transitionId: string,
    expectedGeneration: number,
  ): Promise<AccountRemovalAdmissionProvisionalHandle> {
    return this.#serialize(accountProfileId, () => {
      this.#assertOrdinaryArchiveAdmission(accountProfileId);
      const profile = this.#requireSignedInForArchiveRecovery(accountProfileId);
      if (
        profile.processGeneration !== expectedGeneration ||
        expectedGeneration < 1
      ) {
        throw new AccountServiceError(
          "conflict",
          "Account removal must quarantine the exact active provider generation.",
          false,
          "none",
        );
      }
      const descriptor = Object.freeze({
        accountProfileId,
        expectedGeneration,
        transitionId,
      } satisfies AccountRemovalAdmissionProvisionalDescriptor);
      const handle = this.#archiveAdmissionGate
        .retainAccountRemovalProvisional(descriptor);
      this.#accountRemovalProvisionalsV57.set(handle, descriptor);
      return Promise.resolve(handle);
    });
  }

  promoteAccountRemoval(
    provisionalHandle: AccountRemovalAdmissionProvisionalHandle,
    transitionId: string,
  ): AccountRemovalAdmissionHandle {
    const provisional = this.#requireAccountRemovalProvisional(
      provisionalHandle,
      transitionId,
    );
    const descriptor = this.#providerThreadArchiveJournalV57.recoveryInventory()
      .removalAdmissionDescriptors.find((candidate) =>
        candidate.transitionId === transitionId
      );
    if (
      descriptor === undefined ||
      descriptor.accountProfileId !== provisional.accountProfileId
    ) {
      throw new AccountServiceError(
        "conflict",
        "The durable account-removal authority is unavailable.",
        false,
        "none",
      );
    }
    if (this.#accountRemovalHandlesV57.has(descriptor.transitionId)) {
      throw new AccountServiceError(
        "conflict",
        "This account-removal transition already has recovery authority.",
        false,
        "none",
      );
    }
    const handle = this.#archiveAdmissionGate.promoteAccountRemoval(
      provisionalHandle,
      descriptor,
    );
    this.#accountRemovalHandlesV57.set(descriptor.transitionId, handle);
    this.#accountRemovalProvisionalsV57.delete(provisionalHandle);
    return handle;
  }

  releaseAccountRemoval(
    transitionId: string,
    handle: AccountRemovalAdmissionHandle,
  ): void {
    if (this.#accountRemovalHandlesV57.get(transitionId) !== handle) {
      throw new AccountServiceError(
        "conflict",
        "A stale account-removal authority cannot release its successor.",
        false,
        "none",
      );
    }
    const cut = this.#providerThreadArchiveJournalV57.reopenCut(transitionId);
    if (cut.state !== "contained") {
      throw new AccountServiceError(
        "conflict",
        "Account-removal admission remains held until its exact tombstone is durable.",
        false,
        "none",
      );
    }
    this.#archiveAdmissionGate.releaseAccountRemoval(handle);
    this.#accountRemovalHandlesV57.delete(transitionId);
  }

  abortAccountRemovalProvisional(
    handle: AccountRemovalAdmissionProvisionalHandle,
  ): void {
    const descriptor = this.#requireAccountRemovalProvisional(handle);
    const durable = this.#controlPlaneDatabase.query(`
      SELECT 1 AS present
      FROM chat_provider_thread_archive_cuts_v57
      WHERE cut_id = ?1
    `).get(descriptor.transitionId);
    if (durable !== null) {
      throw new AccountServiceError(
        "conflict",
        "A durable account-removal cut cannot release its provisional quarantine.",
        false,
        "none",
      );
    }
    this.#archiveAdmissionGate.abortAccountRemovalProvisional(handle);
    this.#accountRemovalProvisionalsV57.delete(handle);
  }

  requestChatArchiveSessionWithResponsePosition<
    K extends ChatArchiveSessionRequestKey
  >(
    accountProfileId: AccountSummary['id'],
    authorityHandle: string,
    key: K,
    input: PinnedCodexRequestInput<K>,
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<K>>> {
    return this.#requestSession(
      accountProfileId,
      async () => {
        this.#assertChatArchiveRequest(
          accountProfileId,
          authorityHandle,
          key,
          input,
          expectedGeneration,
        );
        const response = await this.#router.requestWithResponsePosition(
          accountProfileId,
          key,
          input,
          expectedGeneration,
        );
        this.#assertChatArchiveRequest(
          accountProfileId,
          authorityHandle,
          key,
          input,
          expectedGeneration,
        );
        return response;
      },
      authorityHandle,
    );
  }

  /**
   * Ensures a signed-in account's isolated app-server exists and returns the
   * one durable generation shared by the profile store and live router. This
   * is the effect-free recovery seam used before generation-fenced session
   * resume; callers still cannot choose process paths or mutate generation
   * bookkeeping themselves.
   */
  ensureSessionRuntime(
    accountProfileId: AccountSummary['id'],
  ): Promise<Readonly<{ generation: number }>> {
    return this.#ensureSessionRuntimeWithAdmission(accountProfileId, false);
  }

  /** Closed runtime lane used only by the durable thread-archive recovery. */
  ensureChatArchiveSessionRuntime(
    accountProfileId: AccountSummary['id'],
    authorityHandle: string,
  ): Promise<Readonly<{ generation: number }>> {
    return this.#ensureSessionRuntimeWithAdmission(
      accountProfileId,
      authorityHandle,
    );
  }

  #ensureSessionRuntimeWithAdmission(
    accountProfileId: AccountSummary['id'],
    archiveAuthorityHandle: string | false,
  ): Promise<Readonly<{ generation: number }>> {
    const authorityHandle = archiveAuthorityHandle === false
      ? null
      : archiveAuthorityHandle;
    try {
      this.#assertSessionGenerationAvailable(accountProfileId, authorityHandle);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error ? error : new Error("Session admission failed"),
      );
    }
    return this.#serialize(accountProfileId, async () => {
      const profile = this.#requireActive(accountProfileId);
      if (profile.authState !== "signedIn") {
        throw new AccountServiceError(
          "capability_unavailable",
          "Sign in to this Codex account before recovering its sessions.",
          false,
          "signIn",
        );
      }
      this.#assertSessionGenerationAvailable(
        accountProfileId,
        authorityHandle,
      );
      await this.#ensureRuntime(profile);
      this.#assertSessionGenerationAvailable(
        accountProfileId,
        authorityHandle,
      );
      const current = this.#requireActive(accountProfileId);
      const generation = this.#router.generation(accountProfileId);
      if (
        generation === null || !this.#router.isRunning(accountProfileId) ||
        generation !== current.processGeneration
      ) {
        throw new AccountServiceError(
          "runtime_unavailable",
          "The Codex session runtime did not converge to its durable generation.",
          true,
          "restartRuntime",
        );
      }
      return Object.freeze({ generation });
    });
  }

  /**
   * Fences the exact generation whose mutating response was lost. This path
   * deliberately bypasses the ordinary per-account tail: the request at the
   * head of that tail may itself be the wedged operation that needs fencing.
   * Recovery remains lazy so containment can never relaunch behind removal or
   * shutdown, and exact-generation authority cannot stop a newer runtime.
   */
  containAmbiguousChatEffect(
    accountProfileId: string,
    expectedGeneration: number,
  ): Promise<number> {
    return this.containChatGeneration(accountProfileId, expectedGeneration);
  }

  /** Fences only the exact persisted generation owned by a durable effect. */
  containChatGeneration(
    accountProfileId: string,
    expectedGeneration: number,
  ): Promise<number> {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
      return Promise.reject(new AccountServiceError(
        "invalid_request",
        "The provider containment generation is invalid.",
        false,
        "none",
      ));
    }
    if (
      this.#router.generation(accountProfileId) !== expectedGeneration
    ) {
      this.#clearQuarantineIfFenced(accountProfileId, expectedGeneration);
      return Promise.resolve(expectedGeneration);
    }
    this.#quarantinedGenerations.set(accountProfileId, expectedGeneration);

    const active = this.#containmentFlights.get(accountProfileId);
    if (active?.generation === expectedGeneration) return active.promise;
    const predecessor = active?.promise.catch(() => undefined) ?? Promise.resolve();
    const promise = predecessor.then(async () => {
      try {
        await this.#router.fenceGeneration(accountProfileId, expectedGeneration);
        return expectedGeneration;
      } finally {
        this.#clearQuarantineIfFenced(accountProfileId, expectedGeneration);
      }
    });
    const flight = Object.freeze({ generation: expectedGeneration, promise });
    this.#containmentFlights.set(accountProfileId, flight);
    void promise.finally(() => {
      if (this.#containmentFlights.get(accountProfileId) === flight) {
        this.#containmentFlights.delete(accountProfileId);
      }
    }).catch(() => undefined);
    return promise;
  }

  /**
   * Approved provider-thread archive containment. Unlike ordinary ambiguous
   * effect fencing, this operation holds a dedicated admission quarantine
   * across both the exact-generation fence and the registered state-only chat
   * join. A newer runtime is observed as proof that the older generation is
   * already fenced; it is never stopped.
   */
  containChatArchiveGeneration(
    input: ChatArchiveRecoveryDescriptor & Readonly<{ authorityHandle: string }>,
  ): Promise<void> {
    let authority: ChatArchiveRecoveryDescriptor;
    let hold: ChatArchiveRecoveryHold;
    try {
      authority = this.#chatArchiveRecoveryDescriptor(input);
      hold = this.#requireChatArchiveRecoveryHold(
        authority.accountProfileId,
        input.authorityHandle,
      );
      this.#assertChatArchiveRecoveryHoldMatches(hold, authority);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new Error("Archive containment admission failed"),
      );
    }
    const accountProfileId = authority.accountProfileId;
    const flightKey = input.authorityHandle;
    const active = this.#archiveContainmentFlights.get(flightKey);
    if (active !== undefined) return active.promise;
    const predecessor = this.#archiveContainmentTails
      .get(accountProfileId)?.catch(() => undefined) ?? Promise.resolve();
    const promise = predecessor.then(async () => {
      const currentHold = this.#requireChatArchiveRecoveryHold(
        accountProfileId,
        input.authorityHandle,
      );
      this.#assertChatArchiveRecoveryHoldMatches(currentHold, authority);
      if (
        this.#router.generation(accountProfileId) === authority.expectedGeneration
      ) {
        await this.#router.fenceGeneration(
          accountProfileId,
          authority.expectedGeneration,
        );
      }
      this.#assertChatArchiveRecoveryHoldMatches(
        this.#requireChatArchiveRecoveryHold(
          accountProfileId,
          input.authorityHandle,
        ),
        authority,
      );
      await this.#joinChatArchiveGenerationContainment(Object.freeze({
        ...authority,
        authorityHandle: input.authorityHandle,
      }));
    });
    const flight = Object.freeze({
      accountProfileId,
      authorityHandle: input.authorityHandle,
      promise,
    });
    this.#archiveContainmentFlights.set(flightKey, flight);
    this.#archiveContainmentTails.set(accountProfileId, promise);
    void promise.finally(() => {
      if (this.#archiveContainmentFlights.get(flightKey) === flight) {
        this.#archiveContainmentFlights.delete(flightKey);
      }
      if (this.#archiveContainmentTails.get(accountProfileId) === promise) {
        this.#archiveContainmentTails.delete(accountProfileId);
      }
      // Both success and failure retain the durable pane hold. Only the exact
      // pane commit releases it, so a timeout cannot open an N+1 admission gap.
    }).catch(() => undefined);
    return promise;
  }

  retainChatArchiveGeneration(input: ChatArchiveRecoveryDescriptor): string {
    const descriptor = this.#chatArchiveRecoveryDescriptor(input);
    const hold = chatArchiveRecoveryHold(descriptor);
    const paneKey = chatArchiveRecoveryPaneKey(descriptor);
    const existingHandle = this.#archiveRecoveryHoldByPane.get(paneKey);
    if (existingHandle === hold.authorityHandle) return hold.authorityHandle;
    if (existingHandle !== undefined) {
      const existing = this.#archiveRecoveryHolds.get(existingHandle);
      if (
        existing === undefined ||
        existing.accountProfileId !== hold.accountProfileId ||
        existing.paneId !== hold.paneId ||
        existing.purpose !== hold.purpose ||
        existing.expectedRevision !== hold.expectedRevision ||
        existing.expectedQueueRevision !== hold.expectedQueueRevision ||
        existing.restartThreadDigest !== hold.restartThreadDigest ||
        hold.expectedGeneration <= existing.expectedGeneration
      ) {
        throw new AccountServiceError(
          "conflict",
          "The durable provider archive hold changed outside its recovery lineage.",
          false,
          "none",
        );
      }
    }
    // Install the replacement before removing the predecessor. Account-wide
    // quarantine therefore has no zero-hold window across an N -> N+1 rebase.
    this.#archiveRecoveryHolds.set(hold.authorityHandle, hold);
    this.#archiveRecoveryHoldByPane.set(paneKey, hold.authorityHandle);
    if (existingHandle !== undefined) {
      this.#archiveRecoveryHolds.delete(existingHandle);
    }
    return hold.authorityHandle;
  }

  releaseChatArchiveGeneration(
    input: ChatArchiveRecoveryDescriptor & Readonly<{ authorityHandle: string }>,
  ): void {
    const descriptor = this.#chatArchiveRecoveryDescriptor(input);
    const hold = this.#requireChatArchiveRecoveryHold(
      descriptor.accountProfileId,
      input.authorityHandle,
    );
    this.#assertChatArchiveRecoveryHoldMatches(hold, descriptor);
    const paneKey = chatArchiveRecoveryPaneKey(descriptor);
    if (this.#archiveRecoveryHoldByPane.get(paneKey) !== input.authorityHandle) {
      throw new AccountServiceError(
        "conflict",
        "A stale provider archive hold cannot release its successor.",
        false,
        "none",
      );
    }
    this.#archiveRecoveryHoldByPane.delete(paneKey);
    this.#archiveRecoveryHolds.delete(input.authorityHandle);
  }

  isChatRuntimeGenerationCurrent(
    accountProfileId: string,
    expectedGeneration: number,
  ): boolean {
    return Number.isSafeInteger(expectedGeneration) && expectedGeneration >= 1 &&
      this.#router.generation(accountProfileId) === expectedGeneration;
  }

  #requestSession<T>(
    accountProfileId: AccountSummary['id'],
    request: () => Promise<T>,
    archiveAuthorityHandle: string | null = null,
  ): Promise<T> {
    try {
      // Admission checks happen before joining the per-account tail so a
      // request already wedged at its head cannot hide a newly installed
      // ambiguity quarantine from later panes.
      this.#assertSessionGenerationAvailable(
        accountProfileId,
        archiveAuthorityHandle,
      );
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error ? error : new Error("Session admission failed"),
      );
    }
    return this.#serialize(accountProfileId, async () => {
      const profile = this.#requireActive(accountProfileId);
      if (profile.authState !== "signedIn") {
        throw new AccountServiceError(
          "capability_unavailable",
          "Sign in to this Codex account before opening chats.",
          false,
          "signIn",
        );
      }
      this.#assertSessionGenerationAvailable(
        accountProfileId,
        archiveAuthorityHandle,
      );
      await this.#ensureRuntime(profile);
      this.#assertSessionGenerationAvailable(
        accountProfileId,
        archiveAuthorityHandle,
      );
      try {
        return await request();
      } catch (error: unknown) {
        if (this.#expireInvalidAuthentication(accountProfileId, error)) {
          throw new AccountServiceError(
            "capability_unavailable",
            "This Codex session expired. Sign in again before continuing.",
            false,
            "signIn",
          );
        }
        throw serviceError(error);
      }
    });
  }

  #assertSessionGenerationAvailable(
    accountProfileId: string,
    archiveAuthorityHandle: string | null = null,
  ): void {
    if (this.#shuttingDown) {
      throw new AccountServiceError(
        "runtime_unavailable",
        "This Codex account runtime is shutting down.",
        true,
        "restartRuntime",
      );
    }
    // The legacy deterministic archive handle cannot bypass the shared opaque
    // router gate. Only requestArchiveRecoveryWithResponsePosition and
    // ensureArchiveRecoveryRuntime carry v57 authority.
    this.#assertOrdinaryArchiveAdmission(accountProfileId);
    const accountHasArchiveHold = [...this.#archiveRecoveryHolds.values()]
      .some((hold) => hold.accountProfileId === accountProfileId);
    if (archiveAuthorityHandle === null && accountHasArchiveHold) {
      throw new AccountServiceError(
        "runtime_unavailable",
        "This Codex account is recovering a provider thread archive.",
        true,
        "restartRuntime",
      );
    }
    if (archiveAuthorityHandle !== null) {
      this.#requireChatArchiveRecoveryHold(
        accountProfileId,
        archiveAuthorityHandle,
      );
    }
    const quarantined = this.#quarantinedGenerations.get(accountProfileId);
    if (quarantined === undefined) return;
    if (this.#containmentFlights.get(accountProfileId)?.generation === quarantined) {
      throw new AccountServiceError(
        "runtime_unavailable",
        "This Codex account is recovering from an uncertain operation.",
        true,
        "restartRuntime",
      );
    }
    if (
      this.#router.generation(accountProfileId) !== quarantined ||
      !this.#router.isRunning(accountProfileId)
    ) {
      this.#quarantinedGenerations.delete(accountProfileId);
      return;
    }
    throw new AccountServiceError(
      "runtime_unavailable",
      "This Codex account is recovering from an uncertain operation.",
      true,
      "restartRuntime",
    );
  }

  #chatArchiveRecoveryDescriptor(
    input: ChatArchiveRecoveryDescriptor,
  ): ChatArchiveRecoveryDescriptor {
    if (
      input.accountProfileId.length === 0 ||
      input.accountProfileId.length > 128 ||
      input.accountProfileId.includes("\0") ||
      input.paneId.length === 0 ||
      input.paneId.length > 128 ||
      input.paneId.includes("\0") ||
      !Number.isSafeInteger(input.expectedGeneration) ||
      input.expectedGeneration < 1 ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      (
        input.expectedQueueRevision !== null &&
        (!Number.isSafeInteger(input.expectedQueueRevision) ||
          input.expectedQueueRevision < 0)
      ) ||
      (input.purpose === "start_fresh") !==
        (input.expectedQueueRevision !== null) ||
      (input.purpose !== "start_fresh" && input.purpose !== "pane_archive") ||
      input.restartThreadId.length === 0 ||
      input.restartThreadId.length > 512 ||
      input.restartThreadId.includes("\0")
    ) {
      throw new AccountServiceError(
        "invalid_request",
        "The provider archive recovery authority is invalid.",
        false,
        "none",
      );
    }
    return Object.freeze({
      accountProfileId: input.accountProfileId,
      expectedGeneration: input.expectedGeneration,
      expectedQueueRevision: input.expectedQueueRevision,
      expectedRevision: input.expectedRevision,
      paneId: input.paneId,
      purpose: input.purpose,
      restartThreadId: input.restartThreadId,
    });
  }

  #requireChatArchiveRecoveryHold(
    accountProfileId: string,
    authorityHandle: string,
  ): ChatArchiveRecoveryHold {
    const hold = this.#archiveRecoveryHolds.get(authorityHandle);
    if (
      hold === undefined ||
      hold.accountProfileId !== accountProfileId ||
      this.#archiveRecoveryHoldByPane.get(
        chatArchiveRecoveryPaneKey(hold),
      ) !== authorityHandle
    ) {
      throw new AccountServiceError(
        "runtime_unavailable",
        "The exact provider archive recovery hold is unavailable.",
        true,
        "restartRuntime",
      );
    }
    return hold;
  }

  #assertChatArchiveRecoveryHoldMatches(
    hold: ChatArchiveRecoveryHold,
    descriptor: ChatArchiveRecoveryDescriptor,
  ): void {
    if (
      hold.accountProfileId !== descriptor.accountProfileId ||
      hold.expectedGeneration !== descriptor.expectedGeneration ||
      hold.expectedQueueRevision !== descriptor.expectedQueueRevision ||
      hold.expectedRevision !== descriptor.expectedRevision ||
      hold.paneId !== descriptor.paneId ||
      hold.purpose !== descriptor.purpose ||
      hold.restartThreadDigest !== chatArchiveRestartThreadDigest(
        descriptor.restartThreadId,
      )
    ) {
      throw new AccountServiceError(
        "conflict",
        "The provider archive recovery hold does not match its durable intent.",
        false,
        "none",
      );
    }
  }

  #assertChatArchiveRequest<K extends ChatArchiveSessionRequestKey>(
    accountProfileId: string,
    authorityHandle: string,
    key: K,
    input: PinnedCodexRequestInput<K>,
    expectedGeneration: number | undefined,
  ): void {
    const hold = this.#requireChatArchiveRecoveryHold(
      accountProfileId,
      authorityHandle,
    );
    if (key === "threadArchive") {
      const threadId = (input as PinnedCodexRequestInput<"threadArchive">).threadId;
      if (
        expectedGeneration !== hold.expectedGeneration ||
        chatArchiveRestartThreadDigest(threadId) !== hold.restartThreadDigest
      ) {
        throw new AccountServiceError(
          "conflict",
          "The provider archive request does not match its retained hold.",
          false,
          "none",
        );
      }
      return;
    }
    const runtimeGeneration = this.#router.generation(accountProfileId);
    if (
      key !== "threadList" ||
      runtimeGeneration === null ||
      runtimeGeneration <= hold.expectedGeneration ||
      (
        expectedGeneration !== undefined &&
        expectedGeneration !== runtimeGeneration
      )
    ) {
      throw new AccountServiceError(
        "conflict",
        "Archive reconciliation requires the exact fenced successor generation.",
        false,
        "none",
      );
    }
  }

  #clearQuarantineIfFenced(
    accountProfileId: string,
    generation: number | null,
  ): void {
    if (
      generation === null ||
      this.#quarantinedGenerations.get(accountProfileId) !== generation
    ) return;
    if (
      this.#router.generation(accountProfileId) !== generation ||
      !this.#router.isRunning(accountProfileId)
    ) {
      this.#quarantinedGenerations.delete(accountProfileId);
    }
  }

  /**
   * Stops one account runtime as a conservative dispatch-recovery fallback.
   * The isolated app-server is recreated lazily with a fresh durable
   * generation when the signed-in account is used again.
   */
  stopDispatchAccount(accountProfileId: AccountSummary['id']): Promise<void> {
    try {
      this.#assertOrdinaryArchiveAdmission(accountProfileId);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error ? error : new Error("Account admission failed"),
      );
    }
    return this.#serialize(accountProfileId, async () => {
      this.#assertOrdinaryArchiveAdmission(accountProfileId);
      if (this.#store.findAny(accountProfileId) === null) {
        throw new AccountServiceError(
          "not_found",
          "The dispatch account no longer exists.",
          false,
          "none",
        );
      }
      await this.#router.stop(accountProfileId);
    });
  }

  dispatchAccounts(): readonly DispatchAccountSummary[] {
    return this.#store
      .list()
      .filter((profile) => !this.#archiveAdmissionGate.isHeld(profile.id))
      .map((profile) => this.#dispatchSummary(profile))
      .filter((account) => account.authState === "signedIn")
      .toSorted((left, right) => {
        if (left.selected !== right.selected) return left.selected ? -1 : 1;
        return left.label.localeCompare(right.label);
      });
  }

  async refreshDispatchAccounts(): Promise<readonly DispatchAccountSummary[]> {
    const candidates = this.#store.list().filter(({ id, authState }) =>
      authState === "signedIn" && !this.#archiveAdmissionGate.isHeld(id)
    );
    const refreshes = candidates.flatMap((candidate) => {
      // Usage telemetry is advisory. Never queue another refresh behind an
      // unrelated sign-in, removal, or already-running refresh for the same
      // account; its cached candidate remains eligible for pre-effect provider
      // admission. A later provider quota rejection never triggers rerouting.
      if (this.#mutationTails.has(candidate.id)) return [];
      return [this.#serialize(candidate.id, async () => {
        if (this.#archiveAdmissionGate.isHeld(candidate.id)) return;
        const profile = this.#requireActive(candidate.id);
        const ephemeral = this.#ephemeralFor(profile);
        if (!dispatchBudgetNeedsRefresh(ephemeral.usage, this.#now().getTime())) return;
        await this.#refreshDispatchAccount(profile);
      })];
    });
    await settleAdvisoryRefreshes(refreshes, this.#routingRefreshTimeoutMs);
    return this.dispatchAccounts();
  }

  async refreshChatAccountCandidates(): Promise<readonly ChatAccountRoutingCandidate[]> {
    const accounts = await this.refreshDispatchAccounts();
    const now = this.#now().getTime();
    return accounts.map((account) => ({
      id: account.id,
      selected: account.selected,
      budget: chatRoutingBudget(account.usage, now),
      remainingPercent: accountUsageRemainingPercent(account.usage, now),
    }));
  }

  hasRateLimitProofSince(
    accountProfileId: AccountSummary["id"],
    floor: Readonly<{ readonly generation: number; readonly streamPosition: number }>,
  ): boolean {
    if (
      !Number.isSafeInteger(floor.generation) || floor.generation < 1 ||
      !Number.isSafeInteger(floor.streamPosition) || floor.streamPosition < 0
    ) return false;
    const profile = this.#store.find(accountProfileId);
    if (
      profile === null || profile.authState !== "signedIn" ||
      this.#archiveAdmissionGate.isHeld(accountProfileId)
    ) return false;
    const proof = this.#ephemeralFor(profile).quotaProof;
    return proof !== null &&
      proof.generation === floor.generation &&
      this.#router.generation(accountProfileId) === floor.generation &&
      proof.streamPosition >= floor.streamPosition;
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    for (const timer of this.#usageExpiryTimers.values()) timer.cancel();
    this.#usageExpiryTimers.clear();
    // App-server shutdown is the cancellation mechanism for requests already
    // occupying a per-account tail. Waiting for those tails first would let a
    // wedged provider RPC prevent application shutdown forever.
    const [runtimeStop] = await Promise.allSettled([this.#router.stopAll()]);
    while (this.#mutationTails.size > 0) {
      await Promise.allSettled([...this.#mutationTails.values()]);
      await Promise.resolve();
    }
    this.#quarantinedGenerations.clear();
    this.#archiveContainmentFlights.clear();
    this.#archiveContainmentTails.clear();
    this.#archiveRecoveryHoldByPane.clear();
    this.#archiveRecoveryHolds.clear();
    if (runtimeStop?.status === "rejected") {
      throw runtimeStop.reason instanceof Error
        ? runtimeStop.reason
        : new Error("Account runtime shutdown failed");
    }
  }

  handleRuntimeState(accountProfileId: string, state: CodexSupervisorState): void {
    if (this.#archiveAdmissionGate.isHeld(accountProfileId)) return;
    const current = this.#store.find(accountProfileId);
    if (current === null) return;
    if (state.generation !== current.processGeneration) return;
    let profile = current;
    const authority = this.#loginAuthorities.get(accountProfileId);
    const authorityExpired = authority !== undefined &&
      authority.generation === state.generation &&
      runtimeGenerationEnded(state);
    if (authorityExpired) {
      this.#loginAuthorities.delete(accountProfileId);
      if (profile.authState === "signingIn") {
        profile = this.#store.updateAuthState(accountProfileId, "unknown", this.#now());
      }
      if (profile.authState !== "signingOut") {
        this.#reconcileOnRunning.add(accountProfileId);
      }
    }
    profile = this.#store.bumpRevision(accountProfileId, this.#now());
    this.#setEphemeral(accountProfileId, {
      ...this.#ephemeralFor(profile),
      ...(authorityExpired
        ? {
            login: {
              state: "failed" as const,
              message: "Sign-in was interrupted when the account runtime stopped.",
            },
          }
        : {}),
      runtime: runtimeStatusFromSupervisor(state),
    });
    this.#publish(profile);
    if (state.type === "running" && this.#reconcileOnRunning.delete(accountProfileId)) {
      void this.#serialize(accountProfileId, async () => {
        const latest = this.#store.find(accountProfileId);
        if (latest !== null && latest.authState !== "signingOut") {
          await this.#refresh(accountProfileId);
        }
      }).catch(() => undefined);
    }
  }

  consumeCodexFacts(facts: readonly CodexFact[]): void {
    for (const fact of facts) {
      const profile = this.#store.find(fact.accountProfileId);
      if (
        profile === null ||
        this.#archiveAdmissionGate.isHeld(fact.accountProfileId) ||
        fact.generation !== this.#router.generation(fact.accountProfileId)
      ) {
        continue;
      }
      if (fact.type === "account.login_completed") {
        this.#handleLoginCompleted(profile, fact);
      } else if (fact.type === "account.profile_updated") {
        this.#handleAccountUpdated(profile, fact);
      } else if (fact.type === "account.rate_limits_updated") {
        this.#handleRateLimitsUpdated(profile, fact);
      }
    }
  }

  #executeUnserialized(command: AccountRuntimeCommand): Promise<RuntimeCommandResult> {
    switch (command.type) {
      case "runtime.restartAccount":
        return this.#restart(command.accountProfileId);
      case "account.create":
        return this.#create(command.label);
      case "account.login.start":
        return this.#startLogin(command.accountProfileId, command.mode);
      case "account.login.cancel":
        return this.#cancelLogin(command.accountProfileId);
      case "account.login.open":
        return this.#openLogin(command.accountProfileId);
      case "account.logout":
        return this.#logout(command.accountProfileId);
      case "account.refresh":
        return this.#refresh(command.accountProfileId);
      case "account.remove.preview":
        return this.#removePreview(command.accountProfileId);
      case "account.remove":
        return this.#remove(command.accountProfileId, command.expectedRevision);
      case "account.localData.delete.preview":
        return this.#localDataDeletionPreview(command.accountProfileId);
      case "account.localData.delete":
        return this.#deleteLocalData(command.accountProfileId, command.expectedRevision);
      case "account.select":
        return this.#select(command.accountProfileId);
    }
  }

  async #create(label: string): Promise<RuntimeCommandResult> {
    let created: StoredAccountProfile;
    try {
      created = this.#store.create(label, this.#now());
    } catch (error: unknown) {
      throw accountStoreError(error);
    }
    try {
      await this.#profileFileSystem.ensureAccountProfile(created.id);
    } catch (error: unknown) {
      try {
        const rollback = this.#store.tombstone(
          created.id,
          created.revision,
          this.#now(),
        );
        this.#emit({
          type: "accountLocalData.upserted",
          localData: retainedLocalData(rollback.removed),
        });
      } catch (rollbackError: unknown) {
        // The durable active row must remain visible if an unexpected rollback
        // failure prevents us from returning to the pre-command projection.
        this.#publish(this.#store.find(created.id) ?? created);
        throw accountStoreError(rollbackError);
      }
      throw error;
    }
    const account = this.#publish(created);
    return { type: "account", account };
  }

  #select(accountProfileId: string): Promise<RuntimeCommandResult> {
    try {
      const selection = this.#store.select(accountProfileId, this.#now());
      if (selection.deselected !== null) this.#publish(selection.deselected);
      this.#publish(selection.selected);
      return Promise.resolve({ type: "accepted" });
    } catch (error: unknown) {
      return Promise.reject(accountStoreError(error));
    }
  }

  async #startLogin(
    accountProfileId: string,
    mode: "browser" | "deviceCode",
  ): Promise<RuntimeCommandResult> {
    let profile = this.#requireActive(accountProfileId);
    if (profile.authState === "signingOut") {
      throw new AccountServiceError(
        "conflict",
        "Finish the pending logout before signing in again.",
        true,
        "retry",
      );
    }
    const current = this.#ephemeralFor(profile);
    if (current.login.state !== "idle" && current.login.state !== "failed") {
      throw new AccountServiceError(
        "conflict",
        "A sign-in flow is already active for this account.",
        false,
        "none",
      );
    }
    const startedAt = this.#now().toISOString();
    this.#setEphemeral(accountProfileId, {
      ...current,
      login: { state: "starting", mode, startedAt },
    });
    profile = this.#store.updateAuthState(accountProfileId, "signingIn", this.#now());
    this.#publish(profile);

    try {
      await this.#ensureRuntime(profile);
      const response = await this.#router.request(
        accountProfileId,
        "accountLoginStart",
        mode === "browser"
          ? {
              type: "chatgpt",
              codexStreamlinedLogin: true,
              useHostedLoginSuccessPage: true,
              appBrand: "codex",
            }
          : { type: "chatgptDeviceCode" },
      );
      const login = projectLoginStart(response, startedAt);
      profile = this.#store.find(accountProfileId) ?? profile;
      this.#installLoginProjection(profile, login);
      if (login.type !== "immediate") {
        await this.#externalUrlOpener.open(login.authorizationUrl);
      }
      return { type: "accepted" };
    } catch (error: unknown) {
      if (!this.#loginAuthorities.has(accountProfileId)) {
        this.#setFailedLogin(accountProfileId, "Codex sign-in could not be started.");
      }
      throw serviceError(error);
    }
  }

  async #openLogin(accountProfileId: string): Promise<RuntimeCommandResult> {
    this.#requireActive(accountProfileId);
    const authority = this.#loginAuthorities.get(accountProfileId);
    if (authority === undefined || authority.generation !== this.#router.generation(accountProfileId)) {
      throw new AccountServiceError(
        "not_found",
        "There is no active sign-in page for this account.",
        false,
        "none",
      );
    }
    await this.#externalUrlOpener.open(authority.authorizationUrl);
    return { type: "accepted" };
  }

  async #cancelLogin(accountProfileId: string): Promise<RuntimeCommandResult> {
    let profile = this.#requireActive(accountProfileId);
    const authority = this.#loginAuthorities.get(accountProfileId);
    if (authority === undefined || authority.generation !== this.#router.generation(accountProfileId)) {
      throw new AccountServiceError(
        "not_found",
        "There is no active sign-in flow to cancel.",
        false,
        "none",
      );
    }
    this.#setEphemeral(accountProfileId, {
      ...this.#ephemeralFor(profile),
      login: { state: "canceling", mode: authority.mode },
    });
    profile = this.#store.bumpRevision(accountProfileId, this.#now());
    this.#publish(profile);
    try {
      const cancelStatus = projectLoginCancel(await this.#router.request(
        accountProfileId,
        "accountLoginCancel",
        { loginId: authority.loginId },
        authority.generation,
      ));
      this.#loginAuthorities.delete(accountProfileId);
      if (cancelStatus === "notFound") {
        await this.#reconcileAccount(accountProfileId);
      } else {
        this.#setEphemeral(accountProfileId, {
          ...this.#ephemeralFor(profile),
          login: { state: "idle" },
        });
        profile = this.#store.updateAuthState(accountProfileId, "signedOut", this.#now());
        this.#publish(profile);
      }
      return { type: "accepted" };
    } catch (error: unknown) {
      this.#setFailedLogin(accountProfileId, "The sign-in cancellation could not be confirmed.");
      throw serviceError(error);
    }
  }

  async #logout(accountProfileId: string): Promise<RuntimeCommandResult> {
    let profile = this.#requireActive(accountProfileId);
    if (!this.#store.hasRetainedLocalDataCapacity()) {
      throw accountStoreError(
        new AccountProfileCapacityExceeded("retainedLocalData"),
      );
    }
    if (profile.authState !== "signingOut") {
      this.#reconcileOnRunning.delete(accountProfileId);
      this.#loginAuthorities.delete(accountProfileId);
      this.#setEphemeral(accountProfileId, {
        ...this.#ephemeralFor(profile),
        login: { state: "idle" },
        usageRefreshBase: null,
        usage: { state: "unavailable" },
      });
      profile = this.#store.updateAuthState(accountProfileId, "signingOut", this.#now());
      this.#publish(profile);
    }
    try {
      return await this.#finishPendingLogout(accountProfileId);
    } catch (error: unknown) {
      const pending = this.#store.find(accountProfileId);
      if (pending !== null) this.#publish(pending);
      throw serviceError(error);
    }
  }

  async #finishPendingLogout(
    accountProfileId: string,
    profileAlreadyEnsured = false,
  ): Promise<RuntimeCommandResult> {
    const profile = this.#requireActive(accountProfileId);
    if (profile.authState !== "signingOut") {
      throw new AccountServiceError(
        "conflict",
        "This account no longer has a pending logout.",
        false,
        "none",
      );
    }
    await this.#ensureRuntime(profile, profileAlreadyEnsured);
    const fields = projectAccountRead(await this.#router.request(
      accountProfileId,
      "accountRead",
      { refreshToken: false },
    ));
    if (fields.authState === "signedIn") {
      await this.#router.request(accountProfileId, "accountLogout", undefined);
    }
    const latest = this.#requireActive(accountProfileId);
    return await this.#remove(accountProfileId, latest.revision);
  }

  async #refresh(accountProfileId: string): Promise<RuntimeCommandResult> {
    let profile = this.#requireActive(accountProfileId);
    if (profile.authState === "signingOut") {
      throw new AccountServiceError(
        "conflict",
        "This account is finishing its pending logout.",
        true,
        "retry",
      );
    }
    let rateLimitReadFloor: RateLimitReadFloor | null = null;
    if (profile.authState === "expired") {
      this.#setEphemeral(accountProfileId, {
        ...this.#ephemeralFor(profile),
        login: { state: "idle" },
        usageRefreshBase: null,
        usage: { state: "unavailable" },
      });
      this.#publish(this.#store.bumpRevision(accountProfileId, this.#now()));
      return { type: "accepted" };
    }
    const initialEphemeral = this.#ephemeralFor(profile);
    rateLimitReadFloor = {
      generation: profile.processGeneration,
      position: initialEphemeral.rateLimitsPosition,
    };
    this.#setEphemeral(accountProfileId, {
      ...initialEphemeral,
      usageRefreshBase: initialEphemeral.usage.state === "ready"
        ? {
            generation: profile.processGeneration,
            usage: initialEphemeral.usage,
          }
        : null,
      usage: { state: "loading" },
    });
    profile = this.#store.bumpRevision(accountProfileId, this.#now());
    this.#publish(profile);
    await this.#ensureRuntime(profile);
    profile = this.#requireActive(accountProfileId);
    if (profile.processGeneration !== rateLimitReadFloor.generation) {
      rateLimitReadFloor = {
        generation: profile.processGeneration,
        position: null,
      };
    }

    try {
      const fields = projectAccountRead(
        await this.#router.request(
          accountProfileId,
          "accountRead",
          { refreshToken: false },
          rateLimitReadFloor.generation,
        ),
      );
      profile = this.#store.updateIdentityLabel(accountProfileId, fields.identityLabel, this.#now());
      profile = this.#store.updatePlanLabel(accountProfileId, fields.planLabel, this.#now());
      profile = this.#store.updateAuthState(accountProfileId, fields.authState, this.#now());

      if (fields.authState !== "signedIn") {
        this.#setEphemeral(accountProfileId, {
          ...this.#ephemeralFor(profile),
          login: { state: "idle" },
          usageRefreshBase: null,
          usage: { state: "unavailable" },
        });
        profile = this.#store.bumpRevision(accountProfileId, this.#now());
        this.#publish(profile);
        return { type: "accepted" };
      }

      const usageRead = await this.#readUsage(
        accountProfileId,
        rateLimitReadFloor.generation,
      );
      const latest = this.#store.find(accountProfileId);
      if (latest === null || latest.authState !== "signedIn") {
        return { type: "accepted" };
      }
      profile = latest;
      const ephemeral = this.#ephemeralFor(latest);
      const stateAdvanced = rateLimitStateAdvanced(
        latest.processGeneration,
        this.#router.generation(accountProfileId),
        ephemeral.rateLimitsPosition,
        rateLimitReadFloor,
      );
      let usage: AccountUsageState;
      let rateLimitsPosition = ephemeral.rateLimitsPosition;
      if (
        usageRead.rateLimits.status === "fulfilled" &&
        usageRead.rateLimits.value.generation === rateLimitReadFloor.generation &&
        latest.processGeneration === rateLimitReadFloor.generation &&
        this.#router.generation(accountProfileId) === rateLimitReadFloor.generation &&
        !positionPrecedes(usageRead.rateLimits.value, ephemeral.rateLimitsPosition)
      ) {
        try {
          usage = projectRateLimits(
            usageRead.rateLimits.value.output,
            usageRead.observedAt,
            usageRead.tokens,
          );
          rateLimitsPosition = {
            generation: usageRead.rateLimits.value.generation,
            streamPosition: usageRead.rateLimits.value.streamPosition,
          };
        } catch {
          usage = stateAdvanced
            ? usageWithTokens(ephemeral.usage, usageRead.tokens)
            : usageRefreshFailure();
        }
      } else {
        usage = stateAdvanced
          ? usageWithTokens(ephemeral.usage, usageRead.tokens)
          : usageRefreshFailure();
      }
      this.#setEphemeral(accountProfileId, {
        ...ephemeral,
        login: { state: "idle" },
        rateLimitsPosition,
        usageRefreshBase: null,
        usage,
      });
      profile = this.#store.bumpRevision(accountProfileId, this.#now());
      this.#publish(profile);
      return { type: "accepted" };
    } catch (error: unknown) {
      if (this.#expireInvalidAuthentication(accountProfileId, error)) {
        return { type: "accepted" };
      }
      const latest = this.#store.find(accountProfileId);
      if (latest !== null) {
        const ephemeral = this.#ephemeralFor(latest);
        const stateAdvanced = rateLimitReadFloor !== null && rateLimitStateAdvanced(
          latest.processGeneration,
          this.#router.generation(accountProfileId),
          ephemeral.rateLimitsPosition,
          rateLimitReadFloor,
        );
        if (!stateAdvanced) {
          this.#setEphemeral(accountProfileId, {
            ...ephemeral,
            usageRefreshBase: null,
            usage: usageRefreshFailure(),
          });
          this.#publish(this.#store.bumpRevision(accountProfileId, this.#now()));
        }
      }
      throw serviceError(error);
    }
  }

  #removePreview(accountProfileId: string): Promise<RuntimeCommandResult> {
    try {
      const stored = this.#store.removalPreview(accountProfileId);
      const loginActive = this.#loginAuthorities.has(accountProfileId);
      const retainedLocalDataCapacity = stored.localDataState === "present" &&
        !this.#store.hasRetainedLocalDataCapacity();
      const blockers = [
        ...(loginActive ? ["loginActive" as const] : []),
        ...(retainedLocalDataCapacity
          ? ["retainedLocalDataCapacity" as const]
          : []),
      ];
      return Promise.resolve({
        type: "accountRemovalPreview",
        preview: {
          ...stored,
          loginActive,
          runtimeActive: this.#router.isRunning(accountProfileId),
          blockers,
          canRemove: blockers.length === 0,
        },
      });
    } catch (error: unknown) {
      return Promise.reject(accountStoreError(error));
    }
  }

  async #remove(
    accountProfileId: string,
    expectedRevision: number,
  ): Promise<RuntimeCommandResult> {
    const initial = this.#requireActive(accountProfileId);
    if (initial.revision !== expectedRevision) {
      throw new AccountServiceError(
        "stale_revision",
        "The account changed after the removal preview. Review it again.",
        false,
        "none",
      );
    }
    if (this.#loginAuthorities.has(accountProfileId)) {
      throw new AccountServiceError(
        "conflict",
        "Cancel the active sign-in flow before removing this account.",
        false,
        "none",
      );
    }
    if (!this.#store.hasRetainedLocalDataCapacity()) {
      throw accountStoreError(
        new AccountProfileCapacityExceeded("retainedLocalData"),
      );
    }
    await this.#router.stop(accountProfileId);
    try {
      await this.#containChatsBeforeRemoval(accountProfileId);
    } catch {
      throw new AccountServiceError(
        "operation_failed",
        "Chat sessions could not be contained before removing this account.",
        true,
        "retry",
      );
    }
    const latest = this.#requireActive(accountProfileId);
    let result: ReturnType<AccountProfileStore["tombstone"]>;
    try {
      result = this.#store.tombstone(accountProfileId, latest.revision, this.#now());
    } catch (error: unknown) {
      throw accountStoreError(error);
    }
    this.#ephemeral.delete(accountProfileId);
    this.#usageExpiryTimers.get(accountProfileId)?.cancel();
    this.#usageExpiryTimers.delete(accountProfileId);
    this.#emit({ type: "account.removed", accountProfileId });
    this.#emit({
      type: "accountLocalData.upserted",
      localData: retainedLocalData(result.removed),
    });
    if (result.selectedReplacement !== null) this.#publish(result.selectedReplacement);
    return { type: "accepted" };
  }

  #localDataDeletionPreview(accountProfileId: string): Promise<RuntimeCommandResult> {
    const profile = this.#store.findAny(accountProfileId);
    if (profile === null) throw accountStoreError(new AccountProfileNotFound(accountProfileId));
    if (profile.removedAt === null) {
      throw new AccountServiceError(
        "policy_denied",
        "Remove the account profile before deleting its local Codex data.",
        false,
        "none",
      );
    }
    if (profile.localDataState === "deleted") {
      throw new AccountServiceError(
        "not_found",
        "This account's local Codex data has already been deleted.",
        false,
        "none",
      );
    }
    return Promise.resolve({
      type: "accountLocalDataDeletionPreview",
      preview: localDataDeletionPreview(profile),
    });
  }

  async #deleteLocalData(
    accountProfileId: string,
    expectedRevision: number,
  ): Promise<RuntimeCommandResult> {
    const profile = this.#store.findAny(accountProfileId);
    if (profile === null) throw accountStoreError(new AccountProfileNotFound(accountProfileId));
    if (profile.removedAt === null) {
      throw new AccountServiceError(
        "policy_denied",
        "Remove the account profile before deleting its local Codex data.",
        false,
        "none",
      );
    }
    if (profile.revision !== expectedRevision) {
      throw accountStoreError(
        new AccountProfileStaleRevision(accountProfileId, expectedRevision, profile.revision),
      );
    }
    await this.#router.stop(accountProfileId);
    try {
      await this.#profileFileSystem.deleteAccountHome(
        accountProfileId,
        expectedRevision,
      );
    } catch {
      throw new AccountServiceError(
        "operation_failed",
        "This account's local Codex data could not be deleted.",
        true,
        "retry",
      );
    }
    this.#store.markLocalDataDeleted(accountProfileId, expectedRevision, this.#now());
    this.#emit({ type: "accountLocalData.removed", accountProfileId });
    return { type: "accepted" };
  }

  async #restart(accountProfileId: string): Promise<RuntimeCommandResult> {
    const profile = this.#requireActive(accountProfileId);
    if (this.#loginAuthorities.delete(accountProfileId)) {
      this.#setEphemeral(accountProfileId, {
        ...this.#ephemeralFor(profile),
        login: {
          state: "failed",
          message: "Sign-in was interrupted when the account runtime restarted.",
        },
      });
    }
    try {
      if (this.#router.generation(accountProfileId) === null) {
        await this.#ensureRuntime(profile);
      } else if (await this.#router.restart(accountProfileId) === null) {
        throw new Error("Account runtime restart attempts were exhausted");
      }
    } catch {
      throw new AccountServiceError(
        "runtime_unavailable",
        "This account's coding runtime could not restart.",
        true,
        "restartRuntime",
      );
    }
    const latest = this.#store.find(accountProfileId) ?? profile;
    this.#publish(latest);
    return { type: "accepted" };
  }

  async #ensureRuntime(
    profile: StoredAccountProfile,
    profileAlreadyEnsured = false,
    archiveHandle: ArchiveAdmissionHandle | null = null,
  ): Promise<void> {
    this.#assertArchiveAdmission(profile.id, archiveHandle);
    const archiveDescriptor = archiveHandle === null
      ? null
      : this.#requireJournaledArchiveAdmission(archiveHandle, profile.id);
    if (archiveDescriptor !== null) {
      this.#assertArchiveRecoveryProfilePostimage(profile, archiveDescriptor);
    }
    const preclaimedSuccessor =
      archiveDescriptor?.successorGeneration === profile.processGeneration
        ? profile.processGeneration
        : null;
    if (!profileAlreadyEnsured) {
      await this.#profileFileSystem.ensureAccountProfile(profile.id);
      this.#assertArchiveAdmission(profile.id, archiveHandle);
      if (archiveHandle !== null) {
        this.#assertArchiveRecoveryProfilePostimage(
          this.#requireActive(profile.id),
          this.#requireJournaledArchiveAdmission(archiveHandle, profile.id),
        );
      }
    }
    const layout = accountProfileLayout(this.#controlPlanePath, profile.id);
    const ensureOptions: Parameters<AccountRuntimeRouterPort["ensure"]>[2] = {
      initialGeneration: preclaimedSuccessor === null
        ? profile.processGeneration
        : preclaimedSuccessor - 1,
      beforeCreate: (generation) => {
        this.#assertArchiveAdmission(profile.id, archiveHandle);
        let current = this.#requireActive(profile.id);
        const currentArchiveDescriptor = archiveHandle === null
          ? null
          : this.#requireJournaledArchiveAdmission(archiveHandle, profile.id);
        if (currentArchiveDescriptor !== null) {
          this.#assertArchiveRecoveryProfilePostimage(
            current,
            currentArchiveDescriptor,
          );
        }
        const exactPreclaimedSuccessor = archiveHandle !== null &&
          currentArchiveDescriptor?.successorGeneration === generation &&
          current.processGeneration === generation;
        if (!exactPreclaimedSuccessor && generation <= current.processGeneration) {
          throw new Error("Account runtime generation did not advance beyond its durable floor");
        }
        const previousGeneration = exactPreclaimedSuccessor
          ? generation - 1
          : current.processGeneration;
        if (!exactPreclaimedSuccessor) {
          const update = this.#store.updateProcessGeneration(
            profile.id,
            generation,
            this.#now(),
          );
          current = update.profile;
          if (!update.advanced || current.processGeneration !== generation) {
            throw new Error("Account runtime generation was not claimed before process creation");
          }
        }
        const interruptedLogin = this.#loginAuthorities.delete(profile.id);
        if (previousGeneration > 0) {
          if (archiveHandle === null && current.authState !== "signingOut") {
            this.#reconcileOnRunning.add(profile.id);
          }
          if (current.authState === "signingIn") {
            current = this.#store.updateAuthState(profile.id, "unknown", this.#now());
          }
        }
        if (interruptedLogin) {
          this.#setEphemeral(profile.id, {
            ...this.#ephemeralFor(current),
            login: {
              state: "failed",
              message: "Sign-in was interrupted when the account runtime restarted.",
            },
          });
        }
        this.#assertArchiveAdmission(profile.id, archiveHandle);
      },
    };
    if (archiveHandle === null) {
      await this.#router.ensure(
        profile.id,
        accountPaths(this.#assets, layout.codexHome),
        ensureOptions,
      );
    } else {
      await this.#router.ensureArchiveRecovery(
        profile.id,
        accountPaths(this.#assets, layout.codexHome),
        ensureOptions,
        archiveHandle,
      );
    }
    this.#assertArchiveAdmission(profile.id, archiveHandle);
    if (archiveHandle !== null) {
      this.#assertArchiveRecoveryProfilePostimage(
        this.#requireActive(profile.id),
        this.#requireJournaledArchiveAdmission(archiveHandle, profile.id),
      );
    }
  }

  async #readUsage(
    accountProfileId: string,
    expectedGeneration: number,
  ): Promise<AccountUsageRead> {
    const observedAt = this.#now().toISOString();
    const [rateLimits, tokenUsage] = await Promise.allSettled([
      this.#router.requestWithResponsePosition(
        accountProfileId,
        "accountRateLimitsRead",
        undefined,
        expectedGeneration,
      ),
      this.#router.request(
        accountProfileId,
        "accountUsageRead",
        undefined,
        expectedGeneration,
      ),
    ]);
    for (const result of [rateLimits, tokenUsage]) {
      if (
        result.status === "rejected" &&
        result.reason instanceof CodexRemoteResponseError &&
        result.reason.kind === "authentication_invalid"
      ) {
        throw result.reason;
      }
    }
    let tokens: AccountTokenUsageState;
    if (tokenUsage.status === "fulfilled") {
      try {
        tokens = projectTokenUsage(tokenUsage.value, observedAt);
      } catch {
        tokens = tokenUsageRefreshFailure();
      }
    } else {
      tokens = tokenUsageRefreshFailure();
    }
    return { observedAt, rateLimits, tokens };
  }

  async #refreshDispatchAccount(initial: StoredAccountProfile): Promise<void> {
    let profile = initial;
    let rateLimitReadFloor: RateLimitReadFloor | null = null;
    try {
      profile = this.#requireActive(profile.id);
      if (profile.authState !== "signedIn") return;
      rateLimitReadFloor = {
        generation: profile.processGeneration,
        position: this.#ephemeralFor(profile).rateLimitsPosition,
      };
      await this.#ensureRuntime(profile);
      profile = this.#requireActive(profile.id);
      if (profile.processGeneration !== rateLimitReadFloor.generation) {
        rateLimitReadFloor = {
          generation: profile.processGeneration,
          position: null,
        };
      }
      const fields = projectAccountRead(
        await this.#router.request(
          profile.id,
          "accountRead",
          { refreshToken: false },
          rateLimitReadFloor.generation,
        ),
      );
      profile = this.#store.updateIdentityLabel(profile.id, fields.identityLabel, this.#now());
      profile = this.#store.updatePlanLabel(profile.id, fields.planLabel, this.#now());
      profile = this.#store.updateAuthState(profile.id, fields.authState, this.#now());
      const current = this.#ephemeralFor(profile);
      if (fields.authState !== "signedIn") {
        this.#setEphemeral(profile.id, {
          ...current,
          login: { state: "idle" },
          usageRefreshBase: null,
          usage: { state: "unavailable" },
        });
      } else {
        const observedAt = this.#now().toISOString();
        const expectedGeneration = rateLimitReadFloor.generation;
        const positioned = await this.#router.requestWithResponsePosition(
          profile.id,
          "accountRateLimitsRead",
          undefined,
          expectedGeneration,
        );
        const latest = this.#store.find(profile.id);
        if (latest === null || latest.authState !== "signedIn") return;
        profile = latest;
        const ephemeral = this.#ephemeralFor(latest);
        if (
          positioned.generation === expectedGeneration &&
          latest.processGeneration === expectedGeneration &&
          this.#router.generation(profile.id) === expectedGeneration &&
          !positionPrecedes(positioned, ephemeral.rateLimitsPosition)
        ) {
          const tokens = ephemeral.usage.state === "ready"
            ? ephemeral.usage.tokens
            : { state: "unavailable" } as const;
          this.#setEphemeral(profile.id, {
            ...ephemeral,
            login: { state: "idle" },
            rateLimitsPosition: {
              generation: positioned.generation,
              streamPosition: positioned.streamPosition,
            },
            usageRefreshBase: null,
            usage: projectRateLimits(positioned.output, observedAt, tokens),
          });
        }
      }
      this.#publish(this.#store.bumpRevision(profile.id, this.#now()));
    } catch (error: unknown) {
      if (this.#expireInvalidAuthentication(profile.id, error)) return;
      const latest = this.#store.find(profile.id);
      if (latest !== null) {
        const ephemeral = this.#ephemeralFor(latest);
        const newerRateLimitState = rateLimitReadFloor !== null && rateLimitStateAdvanced(
          latest.processGeneration,
          this.#router.generation(profile.id),
          ephemeral.rateLimitsPosition,
          rateLimitReadFloor,
        );
        if (!newerRateLimitState) {
          this.#setEphemeral(profile.id, {
            ...ephemeral,
            usageRefreshBase: null,
            usage: usageRefreshFailure(),
          });
          this.#publish(this.#store.bumpRevision(profile.id, this.#now()));
        }
      }
      throw error;
    }
  }

  async #reconcileAccount(accountProfileId: string): Promise<void> {
    const profile = this.#requireActive(accountProfileId);
    if (profile.authState === "expired") {
      this.#setEphemeral(accountProfileId, {
        ...this.#ephemeralFor(profile),
        login: { state: "idle" },
        usageRefreshBase: null,
        usage: { state: "unavailable" },
      });
      this.#publish(this.#store.bumpRevision(accountProfileId, this.#now()));
      return;
    }
    await this.#ensureRuntime(profile);
    let fields: ReturnType<typeof projectAccountRead>;
    try {
      fields = projectAccountRead(
        await this.#router.request(
          accountProfileId,
          "accountRead",
          { refreshToken: false },
        ),
      );
    } catch (error: unknown) {
      if (this.#expireInvalidAuthentication(accountProfileId, error)) return;
      throw error;
    }
    let updated = this.#store.updateIdentityLabel(accountProfileId, fields.identityLabel, this.#now());
    updated = this.#store.updatePlanLabel(accountProfileId, fields.planLabel, this.#now());
    updated = this.#store.updateAuthState(accountProfileId, fields.authState, this.#now());
    this.#setEphemeral(accountProfileId, {
      ...this.#ephemeralFor(updated),
      login: { state: "idle" },
      ...(fields.authState === "signedIn"
        ? {}
        : {
            usageRefreshBase: null,
            usage: { state: "unavailable" } as const,
          }),
    });
    this.#publish(updated);
  }

  #installLoginProjection(profile: StoredAccountProfile, login: LoginStartProjection): void {
    if (login.type === "immediate") {
      this.#loginAuthorities.delete(profile.id);
    } else {
      this.#loginAuthorities.set(profile.id, {
        authorizationUrl: externalAuthorizationUrl(login.authorizationUrl),
        generation: this.#router.generation(profile.id) ?? profile.processGeneration,
        loginId: login.loginId,
        mode: login.type,
      });
    }
    this.#setEphemeral(profile.id, { ...this.#ephemeralFor(profile), login: login.login });
    this.#publish(this.#store.bumpRevision(profile.id, this.#now()));
  }

  #handleLoginCompleted(
    profile: StoredAccountProfile,
    fact: Extract<CodexFact, { readonly type: "account.login_completed" }>,
  ): void {
    const completed = projectLoginCompleted(fact);
    const authority = this.#loginAuthorities.get(profile.id);
    if (
      authority === undefined ||
      authority.generation !== fact.generation ||
      completed.loginId !== authority.loginId
    ) {
      return;
    }
    this.#loginAuthorities.delete(profile.id);
    this.#setEphemeral(profile.id, {
      ...this.#ephemeralFor(profile),
      login: completed.login,
    });
    let updated = this.#store.updateAuthState(
      profile.id,
      completed.success ? "unknown" : "signedOut",
      this.#now(),
    );
    updated = this.#store.bumpRevision(profile.id, this.#now());
    this.#publish(updated);
    if (completed.success) {
      void this.#serialize(profile.id, async () => {
        await this.#refresh(profile.id);
      }).catch(() => undefined);
    }
  }

  #handleAccountUpdated(
    profile: StoredAccountProfile,
    fact: Extract<CodexFact, { readonly type: "account.profile_updated" }>,
  ): void {
    const fields = projectAccountProfileUpdated(fact);
    let updated = this.#store.updatePlanLabel(profile.id, fields.planLabel, this.#now());
    if (updated.authState !== "expired" && updated.authState !== "signingOut") {
      updated = this.#store.updateAuthState(profile.id, fields.authState, this.#now());
    }
    if (updated.authState !== "signedIn") {
      this.#setEphemeral(profile.id, {
        ...this.#ephemeralFor(updated),
        usageRefreshBase: null,
        usage: { state: "unavailable" },
      });
    }
    this.#publish(updated);
  }

  #handleRateLimitsUpdated(
    profile: StoredAccountProfile,
    fact: Extract<CodexFact, { readonly type: "account.rate_limits_updated" }>,
  ): void {
    const current = this.#store.find(profile.id);
    if (current === null || current.authState !== "signedIn") return;
    const ephemeral = this.#ephemeralFor(current);
    if (positionPrecedes(fact, ephemeral.rateLimitsPosition)) return;
    const previous = ephemeral.usage.state === "loading" &&
        ephemeral.usageRefreshBase?.generation === fact.generation
      ? ephemeral.usageRefreshBase.usage
      : ephemeral.usage;
    const usage = projectRateLimitsUpdated(fact, this.#now().toISOString(), previous);
    const reached = fact.rateLimits.rateLimitReachedType;
    this.#setEphemeral(profile.id, {
      ...ephemeral,
      quotaProof: reached === null || reached === undefined
        ? ephemeral.quotaProof
        : {
            generation: fact.generation,
            streamPosition: fact.streamPosition,
          },
      rateLimitsPosition: {
        generation: fact.generation,
        streamPosition: fact.streamPosition,
      },
      usageRefreshBase: null,
      usage,
    });
    this.#publish(this.#store.bumpRevision(profile.id, this.#now()));
  }

  #setFailedLogin(accountProfileId: string, message: string): void {
    const profile = this.#store.find(accountProfileId);
    if (profile === null) return;
    this.#setEphemeral(accountProfileId, {
      ...this.#ephemeralFor(profile),
      login: { state: "failed", message },
    });
    this.#publish(this.#store.bumpRevision(accountProfileId, this.#now()));
  }

  #expireInvalidAuthentication(accountProfileId: string, error: unknown): boolean {
    if (
      !(error instanceof CodexRemoteResponseError) ||
      error.kind !== "authentication_invalid"
    ) {
      return false;
    }
    const profile = this.#store.find(accountProfileId);
    if (profile === null) return true;
    this.#loginAuthorities.delete(accountProfileId);
    const updated = profile.authState === "expired"
      ? this.#store.bumpRevision(accountProfileId, this.#now())
      : this.#store.updateAuthState(accountProfileId, "expired", this.#now());
    this.#setEphemeral(accountProfileId, {
      ...this.#ephemeralFor(updated),
      login: { state: "idle" },
      usageRefreshBase: null,
      usage: { state: "unavailable" },
    });
    this.#publish(updated);
    return true;
  }

  #assertOrdinaryArchiveAdmission(accountProfileId: string): void {
    try {
      this.#archiveAdmissionGate.assertOrdinaryAdmission(accountProfileId);
    } catch (error: unknown) {
      throw this.#archiveAdmissionError(error);
    }
  }

  #requireArchiveTransitionProvisional(
    handle: ArchiveAdmissionProvisionalHandle,
    transitionId?: string,
  ): ArchiveTransitionProvisionalHoldV57 {
    const descriptor = this.#archiveTransitionProvisionalsV57.get(handle);
    if (
      descriptor === undefined ||
      (transitionId !== undefined && descriptor.transitionId !== transitionId)
    ) {
      throw new AccountServiceError(
        "conflict",
        "The provider archive provisional authority is stale or foreign.",
        false,
        "none",
      );
    }
    return descriptor;
  }

  #assertArchiveTransitionProvisionalIsNotDurable(transitionId: string): void {
    const durable = this.#controlPlaneDatabase.query(`
      SELECT 1 AS present
      FROM chat_provider_thread_archive_targets_v57
      WHERE target_id = ?1
    `).get(transitionId);
    if (durable !== null) {
      throw new AccountServiceError(
        "conflict",
        "A durable provider archive target cannot release its provisional quarantine.",
        false,
        "none",
      );
    }
  }

  #requireAccountRemovalProvisional(
    handle: AccountRemovalAdmissionProvisionalHandle,
    transitionId?: string,
  ): AccountRemovalAdmissionProvisionalDescriptor {
    const descriptor = this.#accountRemovalProvisionalsV57.get(handle);
    if (
      descriptor === undefined ||
      (transitionId !== undefined && descriptor.transitionId !== transitionId)
    ) {
      throw new AccountServiceError(
        "conflict",
        "The account-removal provisional authority is stale or foreign.",
        false,
        "none",
      );
    }
    return descriptor;
  }

  #requireJournaledArchiveAdmission(
    archiveHandle: ArchiveAdmissionHandle,
    accountProfileId: string,
  ): ArchiveAdmissionDescriptor {
    const descriptor = this.#archiveAdmissionGate.require(
      archiveHandle,
      accountProfileId,
    );
    if (
      this.#archiveTransitionHandlesV57.get(descriptor.transitionId) !==
        archiveHandle
    ) {
      throw new AccountServiceError(
        "conflict",
        "The provider archive recovery handle is not the current service authority.",
        false,
        "none",
      );
    }
    const journalDescriptor = this.#providerThreadArchiveJournalV57
      .admissionDescriptor(descriptor.transitionId);
    if (!isDeepStrictEqual(descriptor, journalDescriptor)) {
      throw new AccountServiceError(
        "conflict",
        "The provider archive recovery authority no longer matches its keyed journal.",
        false,
        "none",
      );
    }
    return descriptor;
  }

  #bindArchiveCutTargetsBeforeFence(
    cut: ReturnType<ProviderThreadArchiveJournalV57["reopenCut"]>,
  ): void {
    const inventory = this.#providerThreadArchiveJournalV57.recoveryInventory();
    const targets = new Map(inventory.targets.map((target) =>
      [target.targetId, target] as const
    ));
    const affected = inventory.admissionDescriptors.filter((descriptor) => {
      const target = targets.get(descriptor.transitionId);
      return descriptor.accountProfileId === cut.accountProfileId &&
        descriptor.expectedGeneration === cut.sourceGeneration &&
        target !== undefined &&
        (target.currentAttempt.cutId === null ||
          target.currentAttempt.cutId === cut.cutId);
    });
    if (affected.length !== cut.targetCount) {
      throw new AccountServiceError(
        "conflict",
        "The provider archive cut target inventory is incomplete before fencing.",
        false,
        "none",
      );
    }
    for (const descriptor of affected) {
      const handle = this.#archiveTransitionHandlesV57.get(
        descriptor.transitionId,
      );
      if (handle === undefined) {
        throw new AccountServiceError(
          "conflict",
          "The provider archive cut lacks one replayed target hold.",
          false,
          "none",
        );
      }
      this.#requireJournaledArchiveAdmission(
        handle,
        descriptor.accountProfileId,
      );
    }

    this.#providerThreadArchiveJournalV57.bindAllAffectedTargets(cut.cutId);
    for (const descriptor of affected) {
      const current = this.#archiveTransitionHandlesV57.get(
        descriptor.transitionId,
      );
      if (current === undefined) {
        throw new AccountServiceError(
          "conflict",
          "The provider archive cut target hold disappeared during binding.",
          false,
          "none",
        );
      }
      const successor = this.#providerThreadArchiveJournalV57
        .admissionDescriptor(descriptor.transitionId);
      const observed = this.#archiveAdmissionGate.require(
        current,
        descriptor.accountProfileId,
      );
      if (isDeepStrictEqual(observed, successor)) continue;
      const handle = this.#archiveAdmissionGate.replace(current, successor);
      this.#archiveTransitionHandlesV57.set(
        descriptor.transitionId,
        handle,
      );
    }
  }

  #advanceArchiveCutHandlesFromJournal(
    cutId: string,
  ): ReadonlyMap<string, ArchiveAdmissionHandle> {
    const inventory = this.#providerThreadArchiveJournalV57.recoveryInventory();
    const targetIds = inventory.targets
      .filter((target) => target.currentAttempt.cutId === cutId)
      .map((target) => target.targetId);
    const advanced = new Map<string, ArchiveAdmissionHandle>();
    for (const targetId of targetIds) {
      const current = this.#archiveTransitionHandlesV57.get(targetId);
      if (current === undefined) {
        throw new AccountServiceError(
          "conflict",
          "The contained provider archive cut lacks one target hold.",
          false,
          "none",
        );
      }
      const successor = this.#providerThreadArchiveJournalV57
        .admissionDescriptor(targetId);
      const observed = this.#archiveAdmissionGate.require(
        current,
        successor.accountProfileId,
      );
      const handle = isDeepStrictEqual(observed, successor)
        ? current
        : this.#archiveAdmissionGate.replace(current, successor);
      this.#archiveTransitionHandlesV57.set(targetId, handle);
      advanced.set(targetId, handle);
    }
    return advanced;
  }

  #assertArchiveRecoveryProfilePostimage(
    profile: StoredAccountProfile,
    descriptor: ArchiveAdmissionDescriptor,
  ): void {
    const target = this.#providerThreadArchiveJournalV57.reopenTarget(
      descriptor.transitionId,
    );
    const attempt = target.currentAttempt;
    if (
      attempt.generation !== descriptor.expectedGeneration ||
      descriptor.accountProfileId !== profile.id
    ) {
      throw new AccountServiceError(
        "conflict",
        "The provider archive attempt no longer matches its account generation.",
        false,
        "none",
      );
    }
    if (descriptor.successorGeneration === null) {
      if (
        profile.processGeneration !== attempt.generation ||
        profile.revision !== attempt.accountProfileRevision
      ) {
        throw new AccountServiceError(
          "conflict",
          "The provider archive source profile postimage is incoherent.",
          false,
          "none",
        );
      }
      return;
    }
    if (attempt.cutId === null) {
      throw new AccountServiceError(
        "conflict",
        "The provider archive successor lacks its durable containment cut.",
        false,
        "none",
      );
    }
    const cut = this.#providerThreadArchiveJournalV57.reopenCut(attempt.cutId);
    if (
      cut.accountProfileId !== profile.id ||
      cut.sourceGeneration !== attempt.generation ||
      cut.successorGeneration !== descriptor.successorGeneration ||
      cut.successorAccountProfileRevision !== profile.revision ||
      profile.processGeneration !== descriptor.successorGeneration
    ) {
      throw new AccountServiceError(
        "conflict",
        "The provider archive successor profile postimage is incoherent.",
        false,
        "none",
      );
    }
  }

  #assertArchiveAdmission(
    accountProfileId: string,
    archiveHandle: ArchiveAdmissionHandle | null,
  ): void {
    if (archiveHandle === null) {
      this.#assertOrdinaryArchiveAdmission(accountProfileId);
      return;
    }
    try {
      this.#requireJournaledArchiveAdmission(archiveHandle, accountProfileId);
    } catch (error: unknown) {
      throw this.#archiveAdmissionError(error);
    }
  }

  #archiveAdmissionError(error: unknown): AccountServiceError {
    if (error instanceof AccountServiceError) return error;
    return new AccountServiceError(
      "runtime_unavailable",
      "This Codex account is quarantined for provider archive recovery.",
      true,
      "restartRuntime",
    );
  }

  #requireSignedInForArchiveRecovery(
    accountProfileId: string,
  ): StoredAccountProfile {
    const profile = this.#requireActive(accountProfileId);
    if (profile.authState !== "signedIn") {
      throw new AccountServiceError(
        "capability_unavailable",
        "Sign in to this Codex account before recovering its archived thread.",
        false,
        "signIn",
      );
    }
    return profile;
  }

  #requireActive(accountProfileId: string): StoredAccountProfile {
    const profile = this.#store.find(accountProfileId);
    if (profile === null) throw accountStoreError(new AccountProfileNotFound(accountProfileId));
    return profile;
  }

  #ephemeralFor(profile: StoredAccountProfile): AccountEphemeralState {
    return this.#ephemeral.get(profile.id) ?? {
      login: { state: "idle" },
      quotaProof: null,
      rateLimitsPosition: null,
      usageRefreshBase: null,
      runtime: {
        state: "stopped",
        generation: profile.processGeneration,
      },
      usage: { state: "unavailable" },
    };
  }

  #setEphemeral(accountProfileId: string, value: AccountEphemeralState): void {
    this.#ephemeral.set(accountProfileId, value);
  }

  #summary(profile: StoredAccountProfile, nowMs = this.#now().getTime()): AccountSummary {
    const ephemeral = this.#ephemeralFor(profile);
    return {
      id: profile.id,
      revision: profile.revision,
      label: profile.label,
      selected: profile.selected,
      identityLabel: profile.identityLabel,
      planLabel: profile.planLabel,
      weeklyUsage: profile.authState === "signedIn"
        ? accountWeeklyUsage(ephemeral.usage, nowMs)
        : null,
      authState: profile.authState,
      login: ephemeral.login,
      runtime: ephemeral.runtime,
    };
  }

  #dispatchSummary(profile: StoredAccountProfile): DispatchAccountSummary {
    const ephemeral = this.#ephemeralFor(profile);
    return {
      ...this.#summary(profile),
      usage: ephemeral.usage,
    };
  }

  #publish(profile: StoredAccountProfile): AccountSummary {
    const nowMs = this.#now().getTime();
    const account = this.#summary(profile, nowMs);
    this.#emit({ type: "account.upserted", account });
    this.#scheduleUsageProjectionExpiry(profile, account, nowMs);
    return account;
  }

  #scheduleUsageProjectionExpiry(
    profile: StoredAccountProfile,
    account: AccountSummary,
    nowMs: number,
  ): void {
    this.#usageExpiryTimers.get(profile.id)?.cancel();
    this.#usageExpiryTimers.delete(profile.id);
    const usage = this.#ephemeralFor(profile).usage;
    if (profile.authState !== "signedIn" || usage.state !== "ready") return;
    const routingProjectionDeadline = accountUsageRemainingPercent(usage, nowMs) === null
      ? null
      : accountUsageProjectionDeadline(usage);
    const weeklyResetDeadline = account.weeklyUsage === null
      ? null
      : Date.parse(account.weeklyUsage.resetsAt);
    const deadlines = [routingProjectionDeadline, weeklyResetDeadline].filter(
      (deadline): deadline is number =>
        deadline !== null && Number.isFinite(deadline) && deadline > nowMs,
    );
    if (deadlines.length === 0) return;
    const deadline = Math.min(...deadlines);
    const refreshAfterWeeklyReset = weeklyResetDeadline === deadline;
    const usageUpdatedAt = usage.updatedAt;
    const cancel = this.#usageProjectionScheduler.schedule(() => {
      const timer = this.#usageExpiryTimers.get(profile.id);
      if (timer?.usageUpdatedAt !== usageUpdatedAt) return;
      this.#usageExpiryTimers.delete(profile.id);
      void this.#serialize(profile.id, async () => {
        if (this.#archiveAdmissionGate.isHeld(profile.id)) return Promise.resolve();
        const current = this.#store.find(profile.id);
        const currentUsage = current === null ? null : this.#ephemeralFor(current).usage;
        if (
          current === null ||
          current.authState !== "signedIn" ||
          currentUsage?.state !== "ready" ||
          currentUsage.updatedAt !== usageUpdatedAt
        ) return Promise.resolve();
        if (refreshAfterWeeklyReset) {
          await this.#refreshDispatchAccount(current);
          return;
        }
        this.#publish(current);
      }).catch(() => undefined);
    }, Math.max(1, deadline - nowMs));
    this.#usageExpiryTimers.set(profile.id, { cancel, usageUpdatedAt });
  }

  #serialize<T>(accountProfileId: string, operation: () => Promise<T>): Promise<T> {
    if (this.#shuttingDown) {
      return Promise.reject(new AccountServiceError(
        "runtime_unavailable",
        "The local account service is shutting down.",
        false,
        "none",
      ));
    }
    const previous = this.#mutationTails.get(accountProfileId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => {
      if (this.#shuttingDown) {
        throw new AccountServiceError(
          "runtime_unavailable",
          "The local account service is shutting down.",
          false,
          "none",
        );
      }
      return operation();
    });
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.#mutationTails.set(accountProfileId, settled);
    void settled.then(() => {
      if (this.#mutationTails.get(accountProfileId) === settled) {
        this.#mutationTails.delete(accountProfileId);
      }
    });
    return current;
  }
}

type ResponsePosition = Readonly<{
  generation: number;
  streamPosition: number;
}>;

function positionPrecedes(
  candidate: ResponsePosition,
  current: ResponsePosition | null,
): boolean {
  return current !== null && (
    candidate.generation < current.generation ||
    (
      candidate.generation === current.generation &&
      candidate.streamPosition < current.streamPosition
    )
  );
}

function samePosition(
  left: ResponsePosition | null,
  right: ResponsePosition | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.generation === right.generation &&
      left.streamPosition === right.streamPosition;
}

function rateLimitStateAdvanced(
  processGeneration: number,
  runtimeGeneration: number | null,
  currentPosition: ResponsePosition | null,
  floor: RateLimitReadFloor,
): boolean {
  const currentInExpectedGeneration = currentPosition?.generation === floor.generation
    ? currentPosition
    : null;
  return processGeneration !== floor.generation ||
    runtimeGeneration !== floor.generation ||
    !samePosition(currentInExpectedGeneration, floor.position);
}

function usageWithTokens(
  usage: AccountUsageState,
  tokens: AccountTokenUsageState,
): AccountUsageState {
  return usage.state === "ready" ? { ...usage, tokens } : usage;
}

function usageRefreshFailure(): AccountUsageState {
  return { state: "failed", message: "Usage limits could not be refreshed." };
}

function tokenUsageRefreshFailure(): AccountTokenUsageState {
  return { state: "failed", message: "Token usage could not be refreshed." };
}

function runtimeStatusFromSupervisor(state: CodexSupervisorState): RuntimeStatus {
  switch (state.type) {
    case "idle":
      return { state: "stopped", generation: state.generation };
    case "starting":
      return { state: "starting", generation: state.generation };
    case "running":
      return {
        state: "ready",
        generation: state.generation,
      };
    case "backing_off":
      return {
        state: "backingOff",
        generation: state.generation,
        retryAt: new Date(Date.now() + state.delayMs).toISOString(),
        attempt: state.attempt,
      };
    case "failed":
      return {
        state: "failed",
        generation: state.generation,
        message: "This account's coding runtime could not start.",
        canRestart: true,
      };
    case "stopped":
      return { state: "stopped", generation: state.generation };
  }
}

function commandAccountProfileId(command: AccountRuntimeCommand): string | null {
  switch (command.type) {
    case "runtime.restartAccount":
    case "account.login.start":
    case "account.login.cancel":
    case "account.login.open":
    case "account.logout":
    case "account.refresh":
    case "account.remove.preview":
    case "account.remove":
    case "account.localData.delete.preview":
    case "account.localData.delete":
    case "account.select":
      return command.accountProfileId;
    case "account.create":
      return null;
  }
}

function retainedLocalData(profile: StoredAccountProfile): RetainedAccountLocalData {
  if (profile.removedAt === null || profile.localDataState !== "present") {
    throw new Error("Only removed profiles with retained local data can be projected");
  }
  return {
    id: profile.id,
    revision: profile.revision,
    label: profile.label,
    removedAt: profile.removedAt,
  };
}

function localDataDeletionPreview(
  profile: StoredAccountProfile,
): AccountLocalDataDeletionPreview {
  const retained = retainedLocalData(profile);
  return {
    accountProfileId: retained.id,
    accountRevision: retained.revision,
    label: retained.label,
    removedAt: retained.removedAt,
    deletes: {
      credentials: true,
      sessionsAndHistory: true,
      configuration: true,
      logs: true,
    },
  };
}

async function settleAdvisoryRefreshes(
  refreshes: readonly Promise<unknown>[],
  timeoutMs: number,
): Promise<void> {
  if (refreshes.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      Promise.allSettled(refreshes).then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function positiveRoutingRefreshTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new RangeError("routingRefreshTimeoutMs must be an integer from 1 to 60000");
  }
  return value;
}

function isTransientAuthState(authState: AccountSummary["authState"]): boolean {
  return authState === "signingIn" || authState === "signingOut";
}

function runtimeGenerationEnded(state: CodexSupervisorState): boolean {
  return state.type === "backing_off" || state.type === "failed" || state.type === "stopped";
}

function chatArchiveRecoveryPaneKey(
  input: Pick<ChatArchiveRecoveryDescriptor, "accountProfileId" | "paneId">,
): string {
  return JSON.stringify([input.accountProfileId, input.paneId]);
}

function providerArchiveEvidenceDigestV57(
  domain: string,
  value: unknown,
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`hra.chat.provider-archive-v57.${domain}\0`);
  hasher.update(JSON.stringify(value));
  return hasher.digest("hex");
}

function emptyProviderThreadArchiveTerminalCleanupV57():
  ProviderThreadArchiveTerminalCleanupV57 {
  return Object.freeze({
    deletedTargetIds: Object.freeze([]),
    deletedCutIds: Object.freeze([]),
  });
}

function chatArchiveRestartThreadDigest(restartThreadId: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update("hra.chat.archive-restart-thread.v1\0");
  hasher.update(restartThreadId);
  return hasher.digest("hex");
}

function chatArchiveRecoveryHold(
  input: ChatArchiveRecoveryDescriptor,
): ChatArchiveRecoveryHold {
  const restartThreadDigest = chatArchiveRestartThreadDigest(
    input.restartThreadId,
  );
  const fingerprint = {
    accountProfileId: input.accountProfileId,
    expectedGeneration: input.expectedGeneration,
    expectedQueueRevision: input.expectedQueueRevision,
    expectedRevision: input.expectedRevision,
    paneId: input.paneId,
    purpose: input.purpose,
    restartThreadDigest,
  };
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update("hra.chat.archive-recovery-hold.v1\0");
  hasher.update(JSON.stringify(fingerprint));
  return Object.freeze({
    ...fingerprint,
    authorityHandle: `chatarchivehold_${hasher.digest("hex")}`,
  });
}

function accountStoreError(error: unknown): AccountServiceError {
  if (error instanceof AccountProfileCapacityExceeded) {
    return new AccountServiceError(
      "capacity_full",
      error.capacity === "active"
        ? "The subscription limit is full. Remove an account before adding another."
        : "Delete retained data from a removed subscription before adding or removing another.",
      false,
      "none",
    );
  }
  if (error instanceof AccountProfileStaleRevision) {
    return new AccountServiceError(
      "stale_revision",
      "The account changed after this view was loaded.",
      false,
      "none",
    );
  }
  if (error instanceof AccountProfileNotFound) {
    return new AccountServiceError(
      "not_found",
      "The account profile no longer exists.",
      false,
      "none",
    );
  }
  return serviceError(error);
}

function serviceError(error: unknown): AccountServiceError {
  if (error instanceof AccountServiceError) return error;
  if (error instanceof AccountProfileNotFound || error instanceof AccountProfileStaleRevision) {
    return accountStoreError(error);
  }
  if (error instanceof CodexRequestExpiredError) {
    if (error.intent === "ambiguousMutation") {
      return new AccountServiceError(
        "upstream_ambiguous",
        "Codex did not confirm whether the operation completed.",
        false,
        "resolveAttention",
      );
    }
    return new AccountServiceError(
      "runtime_unavailable",
      "The account runtime stopped before it could answer.",
      true,
      "restartRuntime",
    );
  }
  if (error instanceof AccountRuntimeCapacityError) {
    return new AccountServiceError(
      "runtime_unavailable",
      "This Codex account is waiting for local runtime capacity.",
      true,
      "retry",
    );
  }
  if (error instanceof CodexRemoteResponseError) {
    return new AccountServiceError(
      "operation_failed",
      "Codex rejected the account operation.",
      false,
      "none",
    );
  }
  return new AccountServiceError(
    "operation_failed",
    "The account operation could not be completed.",
    false,
    "none",
  );
}
