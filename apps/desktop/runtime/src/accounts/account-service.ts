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
import {
  AccountRuntimeCapacityError,
  type AccountRuntimeRequestKey,
} from "./runtime-router";

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

export interface AccountRuntimeRouterPort {
  ensure(
    accountProfileId: AccountSummary['id'],
    paths: RuntimePaths,
    options: {
      readonly initialGeneration: number;
      readonly beforeCreate: (generation: number) => void | Promise<void>;
    },
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
  fenceGeneration(
    accountProfileId: AccountSummary['id'],
    expectedGeneration: number,
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
  | "threadResume"
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
  | "turnStart"
  | "turnSteer"
  | "turnInterrupt">;

export interface ExternalUrlOpener {
  open(url: string): Promise<void>;
}

export interface AccountUsageProjectionScheduler {
  schedule(callback: () => void, delayMs: number): () => void;
}

export interface AccountServiceOptions {
  readonly assets: PortableRuntimeAssets;
  readonly controlPlanePath: string;
  readonly emit: (event: AccountEvent) => void;
  readonly externalUrlOpener?: ExternalUrlOpener;
  readonly profileFileSystem: AccountProfileFileSystem;
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
  readonly #assets: PortableRuntimeAssets;
  readonly #controlPlanePath: string;
  readonly #emit: (event: AccountEvent) => void;
  readonly #ephemeral = new Map<string, AccountEphemeralState>();
  readonly #externalUrlOpener: ExternalUrlOpener;
  readonly #loginAuthorities = new Map<string, LoginAuthority>();
  readonly #profileFileSystem: AccountProfileFileSystem;
  readonly #containmentFlights = new Map<string, Readonly<{
    generation: number;
    promise: Promise<void>;
  }>>();
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
  #shuttingDown = false;

  constructor(options: AccountServiceOptions) {
    this.#assets = options.assets;
    this.#controlPlanePath = options.controlPlanePath;
    this.#emit = options.emit;
    this.#externalUrlOpener = options.externalUrlOpener ?? new MacOsExternalUrlOpener();
    this.#profileFileSystem = options.profileFileSystem;
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

  initialize(): Promise<readonly AccountSummary[]> {
    const storedProfiles = this.#store.list();
    const preparations: Array<Readonly<{
      profileId: string;
      reconcileRuntime: boolean;
      refreshUsage: boolean;
      resumeLogout: boolean;
    }>> = [];
    const accounts = storedProfiles.map((stored) => {
      let profile = stored;
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
      await this.#serialize(preparation.profileId, async () => {
        try {
          await this.#profileFileSystem.ensureAccountProfile(preparation.profileId);
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
    return this.#serialize(accountProfileId, () => this.#executeUnserialized(command));
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
   * Ensures a signed-in account's isolated app-server exists and returns the
   * one durable generation shared by the profile store and live router. This
   * is the effect-free recovery seam used before generation-fenced session
   * resume; callers still cannot choose process paths or mutate generation
   * bookkeeping themselves.
   */
  ensureSessionRuntime(
    accountProfileId: AccountSummary['id'],
  ): Promise<Readonly<{ generation: number }>> {
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
      this.#assertSessionGenerationAvailable(accountProfileId);
      await this.#ensureRuntime(profile);
      this.#assertSessionGenerationAvailable(accountProfileId);
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
  containAmbiguousChatEffect(accountProfileId: string): Promise<void> {
    const expectedGeneration = this.#router.generation(accountProfileId);
    if (expectedGeneration === null) return Promise.resolve();
    this.#quarantinedGenerations.set(accountProfileId, expectedGeneration);

    const active = this.#containmentFlights.get(accountProfileId);
    if (active?.generation === expectedGeneration) return active.promise;
    const predecessor = active?.promise.catch(() => undefined) ?? Promise.resolve();
    const promise = predecessor.then(async () => {
      try {
        await this.#router.fenceGeneration(accountProfileId, expectedGeneration);
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

  #requestSession<T>(
    accountProfileId: AccountSummary['id'],
    request: () => Promise<T>,
  ): Promise<T> {
    try {
      // Admission checks happen before joining the per-account tail so a
      // request already wedged at its head cannot hide a newly installed
      // ambiguity quarantine from later panes.
      this.#assertSessionGenerationAvailable(accountProfileId);
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
      this.#assertSessionGenerationAvailable(accountProfileId);
      await this.#ensureRuntime(profile);
      this.#assertSessionGenerationAvailable(accountProfileId);
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

  #assertSessionGenerationAvailable(accountProfileId: string): void {
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
    return this.#serialize(accountProfileId, async () => {
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
      .map((profile) => this.#dispatchSummary(profile))
      .filter((account) => account.authState === "signedIn")
      .toSorted((left, right) => {
        if (left.selected !== right.selected) return left.selected ? -1 : 1;
        return left.label.localeCompare(right.label);
      });
  }

  async refreshDispatchAccounts(): Promise<readonly DispatchAccountSummary[]> {
    const candidates = this.#store.list().filter(({ authState }) => authState === "signedIn");
    const refreshes = candidates.flatMap((candidate) => {
      // Usage telemetry is advisory. Never queue another refresh behind an
      // unrelated sign-in, removal, or already-running refresh for the same
      // account; its cached candidate remains eligible for pre-effect provider
      // admission. A later provider quota rejection never triggers rerouting.
      if (this.#mutationTails.has(candidate.id)) return [];
      return [this.#serialize(candidate.id, async () => {
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
    if (profile === null || profile.authState !== "signedIn") return false;
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
    if (runtimeStop?.status === "rejected") {
      throw runtimeStop.reason instanceof Error
        ? runtimeStop.reason
        : new Error("Account runtime shutdown failed");
    }
  }

  handleRuntimeState(accountProfileId: string, state: CodexSupervisorState): void {
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
  ): Promise<void> {
    if (!profileAlreadyEnsured) {
      await this.#profileFileSystem.ensureAccountProfile(profile.id);
    }
    const layout = accountProfileLayout(this.#controlPlanePath, profile.id);
    await this.#router.ensure(profile.id, accountPaths(this.#assets, layout.codexHome), {
      initialGeneration: profile.processGeneration,
      beforeCreate: (generation) => {
        let current = this.#requireActive(profile.id);
        if (generation <= current.processGeneration) {
          throw new Error("Account runtime generation did not advance beyond its durable floor");
        }
        const previousGeneration = current.processGeneration;
        const update = this.#store.updateProcessGeneration(profile.id, generation, this.#now());
        current = update.profile;
        if (!update.advanced || current.processGeneration !== generation) {
          throw new Error("Account runtime generation was not claimed before process creation");
        }
        const interruptedLogin = this.#loginAuthorities.delete(profile.id);
        if (previousGeneration > 0) {
          if (current.authState !== "signingOut") {
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
      },
    });
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
      usageRemainingPercent: profile.authState === "signedIn"
        ? accountUsageRemainingPercent(ephemeral.usage, nowMs)
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
    if (
      profile.authState !== "signedIn" ||
      account.usageRemainingPercent === null ||
      usage.state !== "ready"
    ) return;
    const deadline = accountUsageProjectionDeadline(usage);
    if (deadline === null || deadline <= nowMs) return;
    const usageUpdatedAt = usage.updatedAt;
    const cancel = this.#usageProjectionScheduler.schedule(() => {
      const timer = this.#usageExpiryTimers.get(profile.id);
      if (timer?.usageUpdatedAt !== usageUpdatedAt) return;
      this.#usageExpiryTimers.delete(profile.id);
      void this.#serialize(profile.id, () => {
        const current = this.#store.find(profile.id);
        const currentUsage = current === null ? null : this.#ephemeralFor(current).usage;
        if (
          current === null ||
          current.authState !== "signedIn" ||
          currentUsage?.state !== "ready" ||
          currentUsage.updatedAt !== usageUpdatedAt
        ) return Promise.resolve();
        this.#publish(current);
        return Promise.resolve();
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
    const current = previous.catch(() => undefined).then(operation);
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
