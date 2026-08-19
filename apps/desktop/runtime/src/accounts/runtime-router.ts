import {
  accountProfileIdSchema,
  type AccountSummary,
} from "../../../contracts/runtime";
import { CodexAppServerProcess } from "../app-server-process";
import {
  CodexRestartSupervisor,
  type CodexExpiredServerRequestFault,
  type CodexNotification,
  type CodexProtocolDiagnostic,
  type CodexRespondableServerRequest,
  isPinnedCodexDynamicToolProbeWitness,
  type PinnedCodexDynamicToolProtocolCapability,
  type PinnedCodexDynamicToolRequest,
  type PinnedCodexRequestInput,
  type PinnedCodexRequestKey,
  type PinnedCodexRequestOutput,
  type PinnedCodexResponseAtPosition,
  type CodexRestartPolicy,
  type CodexRpcCallbacks,
  type CodexServerRequest,
  type CodexServerResponse,
  type CodexStreamPosition,
  type CodexSupervisorState,
  type SupervisedCodexGeneration,
} from "../codex";
import type { RuntimePaths } from "../runtime-paths";
import {
  ArchiveAdmissionAuthorityError,
  ArchiveAdmissionGate,
  type AccountRemovalAdmissionHandle,
  type ArchiveAdmissionDescriptor,
  type ArchiveAdmissionEffectClaim,
  type ArchiveAdmissionHandle,
  archiveRestartThreadDigest,
} from "./archive-admission-gate";

type Awaitable<T> = T | Promise<T>;
export type AccountProfileId = AccountSummary["id"];
export type AccountRuntimeFaultReason = "process_exited" | "protocol_fault";
export type AccountRuntimeStateCause =
  | "capacity_evicted"
  | "explicit_stop"
  | "provider_lifecycle"
  | "router_shutdown";
export type AccountRuntimeFenceResult = "already_fenced" | "fenced";
export type AccountRuntimeRequestKey = Exclude<PinnedCodexRequestKey, "clientInitialize">;
export type AccountRuntimeArchiveRecoveryRequestKey = Extract<
  AccountRuntimeRequestKey,
  "threadArchive" | "threadList"
>;

export type AccountRuntimeRouterBoundary =
  | "archive_recovery_request"
  | "callback_dispatch"
  | "capacity_admission"
  | "dynamic_tool_capability"
  | "process_creation"
  | "request"
  | "request_with_position"
  | "respond"
  | "restart";

export interface AccountRuntimeRouterBoundaryInput {
  readonly accountProfileId: AccountProfileId;
  readonly boundary: AccountRuntimeRouterBoundary;
  readonly generation?: number;
  readonly requestKey?: AccountRuntimeRequestKey;
}

export interface AccountRuntimeRouterTestHooks {
  /** Deterministic race seam. Production compositions leave this undefined. */
  readonly beforeBoundary?: (
    input: AccountRuntimeRouterBoundaryInput,
  ) => Awaitable<void>;
}

export interface AccountRuntimeProcessProtocol {
  request<K extends AccountRuntimeRequestKey>(
    key: K,
    input: PinnedCodexRequestInput<K>,
  ): Promise<PinnedCodexRequestOutput<K>>;
  requestWithResponsePosition<K extends AccountRuntimeRequestKey>(
    key: K,
    input: PinnedCodexRequestInput<K>,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<K>>>;
  respond(
    request: CodexRespondableServerRequest,
    response: CodexServerResponse,
  ): Promise<CodexStreamPosition | void>;
}

export interface AccountRuntimeProcess extends SupervisedCodexGeneration {
  readonly protocol: AccountRuntimeProcessProtocol;
  readonly faulted: Promise<AccountRuntimeFaultReason>;
}

export interface AccountRuntimeObservation {
  readonly generation: number;
  readonly status: "running";
}

export interface AccountRuntimeCallbacks {
  readonly onNotification?: (
    accountProfileId: AccountProfileId,
    notification: CodexNotification,
  ) => Awaitable<void>;
  readonly onServerRequest?: (
    accountProfileId: AccountProfileId,
    request: CodexServerRequest,
  ) => Awaitable<void>;
  readonly onDynamicToolRequest?: (
    accountProfileId: AccountProfileId,
    request: PinnedCodexDynamicToolRequest,
  ) => Awaitable<void>;
  readonly onDiagnostic?: (
    accountProfileId: AccountProfileId,
    diagnostic: CodexProtocolDiagnostic,
  ) => Awaitable<void>;
  readonly onServerRequestExpired?: (
    accountProfileId: AccountProfileId,
    fault: CodexExpiredServerRequestFault,
  ) => Awaitable<void>;
  readonly onState?: (
    accountProfileId: AccountProfileId,
    state: CodexSupervisorState,
    cause: AccountRuntimeStateCause,
  ) => void;
}

export interface AccountRuntimeProcessFactoryInput {
  readonly accountProfileId: AccountProfileId;
  readonly callbacks: CodexRpcCallbacks;
  readonly dynamicToolCapability: PinnedCodexDynamicToolProtocolCapability | null;
  readonly generation: number;
  readonly paths: RuntimePaths;
}

export type AccountRuntimeProcessFactory = (
  input: AccountRuntimeProcessFactoryInput,
) => Promise<AccountRuntimeProcess>;

export interface AccountRuntimeDynamicToolCapabilityResolverInput {
  readonly accountProfileId: AccountProfileId;
  readonly generation: number;
  readonly paths: RuntimePaths;
}

/**
 * Trusted gateway seam. The resolver hashes `paths.codexBinary`, verifies the
 * immutable probe evidence, and binds the capability to this exact local
 * account and durable process generation. Any uncertainty returns null.
 */
export type AccountRuntimeDynamicToolCapabilityResolver = (
  input: AccountRuntimeDynamicToolCapabilityResolverInput,
) => Awaitable<PinnedCodexDynamicToolProtocolCapability | null>;

export interface AccountRuntimeRouterOptions {
  readonly admissionTimeoutMs?: number;
  readonly archiveAdmissionGate: ArchiveAdmissionGate;
  readonly callbacks?: AccountRuntimeCallbacks;
  readonly createProcess?: AccountRuntimeProcessFactory;
  readonly dynamicToolCapability?: AccountRuntimeDynamicToolCapabilityResolver;
  readonly maximumLiveProcesses?: number;
  readonly now?: () => number;
  readonly policy?: CodexRestartPolicy;
  readonly restartBudgetResetMs?: number;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly testHooks?: AccountRuntimeRouterTestHooks;
}

export interface AccountRuntimeEnsureOptions {
  readonly beforeCreate: (generation: number) => void | Promise<void>;
  readonly initialGeneration: number;
}

interface AccountRoute {
  activeCallbacks: number;
  activeOperations: number;
  readonly activeTurns: Set<string>;
  readonly accountProfileId: AccountProfileId;
  archiveQuiescenceInvalidatedGeneration: number | null;
  readonly completedLoginIds: Set<string>;
  readonly completedTurns: Set<string>;
  readonly expectedThreadArchiveNotifications: Set<string>;
  readonly paths: RuntimePaths;
  processStartAuthority: ProcessStartAuthority | null;
  readonly pendingServerRequests: Set<CodexRespondableServerRequest>;
  pendingLoginId: string | null;
  lastUsed: number;
  slotHeld: boolean;
  stateCause: AccountRuntimeStateCause;
  stop: Promise<void> | null;
  stopping: boolean;
  readonly supervisor: CodexRestartSupervisor<AccountRuntimeProcess>;
  dynamicToolCapability: PinnedCodexDynamicToolProtocolCapability | null;
  releaseArchiveAdmissionSubscription: (() => void) | null;
}

interface ProcessStartAuthority {
  readonly archiveHandle: ArchiveAdmissionHandle | null;
  readonly generation: number;
}

interface ProcessCallbackAuthority {
  readonly generation: number;
  process: AccountRuntimeProcess | null;
}

interface RuntimeAdmissionWaiter {
  readonly archiveHandle: ArchiveAdmissionHandle | null;
  readonly deadline: number;
  readonly reject: (error: Error) => void;
  readonly resolve: () => void;
  readonly route: AccountRoute;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const defaultPolicy: CodexRestartPolicy = {
  initialDelayMs: 100,
  maximumDelayMs: 5_000,
  maximumRestartAttempts: 5,
};
const defaultAdmissionTimeoutMs = 30_000;
const defaultMaximumLiveProcesses = 32;
const maximumCompletedTurnTombstones = 128;
const maximumCompletedLoginTombstones = 8;
const maximumExpectedThreadArchiveNotificationTombstones = 128;

function samePaths(left: RuntimePaths, right: RuntimePaths): boolean {
  return left.codexBinary === right.codexBinary &&
    left.codexHome === right.codexHome &&
    left.gitBinary === right.gitBinary &&
    left.gitRoot === right.gitRoot;
}

function validateGenerationFloor(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("Account runtime generation floor must be a nonnegative safe integer");
  }
}

function defaultProcessFactory(
  input: AccountRuntimeProcessFactoryInput,
): Promise<AccountRuntimeProcess> {
  return CodexAppServerProcess.start(input.generation, input.paths, {
    callbacks: input.callbacks,
    ...(input.dynamicToolCapability === null
      ? {}
      : { dynamicToolCapability: input.dynamicToolCapability }),
  });
}

export class AccountRuntimeNotConfiguredError extends Error {
  constructor() {
    super("The account runtime has not been configured.");
    this.name = "AccountRuntimeNotConfiguredError";
  }
}

export class AccountRuntimePathMismatchError extends Error {
  constructor() {
    super("The account runtime cannot be rebound to different paths.");
    this.name = "AccountRuntimePathMismatchError";
  }
}

export class AccountRuntimeGenerationFloorMismatchError extends Error {
  constructor() {
    super("The account runtime generation cannot move behind a newer persisted floor.");
    this.name = "AccountRuntimeGenerationFloorMismatchError";
  }
}

export class AccountRuntimeStaleRequestError extends Error {
  constructor() {
    super("The account runtime request is no longer active.");
    this.name = "AccountRuntimeStaleRequestError";
  }
}

export class AccountRuntimeNotQuiescentError extends Error {
  constructor() {
    super("The account runtime still owns active provider work.");
    this.name = "AccountRuntimeNotQuiescentError";
  }
}

export class AccountRuntimeCapacityError extends Error {
  constructor() {
    super("The account runtime is waiting for local process capacity.");
    this.name = "AccountRuntimeCapacityError";
  }
}

export class AccountRuntimeRouter {
  readonly #admissionTimeoutMs: number;
  readonly #admissionQueue: RuntimeAdmissionWaiter[] = [];
  readonly #archiveAdmissionGate: ArchiveAdmissionGate;
  readonly #callbacks: AccountRuntimeCallbacks;
  readonly #createProcess: AccountRuntimeProcessFactory;
  readonly #dynamicToolCapability: AccountRuntimeDynamicToolCapabilityResolver | null;
  readonly #maximumLiveProcesses: number;
  readonly #now: () => number;
  readonly #policy: CodexRestartPolicy;
  readonly #restartBudgetResetMs: number | undefined;
  readonly #routes = new Map<AccountProfileId, AccountRoute>();
  readonly #serverRequestOwners = new WeakMap<
    CodexRespondableServerRequest,
    Readonly<{
      accountProfileId: AccountProfileId;
      generation: number;
      process: AccountRuntimeProcess;
    }>
  >();
  readonly #sleep: ((delayMs: number) => Promise<void>) | undefined;
  readonly #testHooks: AccountRuntimeRouterTestHooks;
  #admissionProcessing = false;
  #capacityGeneration = 0;
  #capacityWait: Readonly<{
    promise: Promise<number>;
    resolve: (generation: number) => void;
  }> | null = null;
  #closed = false;
  #routeClock = 0;

  constructor(options: AccountRuntimeRouterOptions) {
    if (!(options.archiveAdmissionGate instanceof ArchiveAdmissionGate)) {
      throw new Error("Account runtime routing requires one shared archive admission gate");
    }
    this.#admissionTimeoutMs = positiveRouterLimit(
      options.admissionTimeoutMs,
      defaultAdmissionTimeoutMs,
      10 * 60_000,
      "Account runtime admission timeout",
    );
    this.#callbacks = options.callbacks ?? {};
    this.#archiveAdmissionGate = options.archiveAdmissionGate;
    this.#createProcess = options.createProcess ?? defaultProcessFactory;
    // Capability evidence and a response owner are one atomic configuration.
    // Never advertise a provider callback that the gateway cannot settle.
    this.#dynamicToolCapability =
      options.callbacks?.onDynamicToolRequest === undefined
        ? null
        : options.dynamicToolCapability ?? null;
    this.#maximumLiveProcesses = positiveRouterLimit(
      options.maximumLiveProcesses,
      defaultMaximumLiveProcesses,
      defaultMaximumLiveProcesses,
      "Account runtime process limit",
    );
    this.#now = options.now ?? Date.now;
    this.#policy = options.policy ?? defaultPolicy;
    this.#restartBudgetResetMs = options.restartBudgetResetMs;
    this.#sleep = options.sleep;
    this.#testHooks = options.testHooks ?? {};
  }

  async ensure(
    accountProfileId: AccountProfileId,
    paths: RuntimePaths,
    options: AccountRuntimeEnsureOptions,
  ): Promise<AccountRuntimeObservation> {
    const profileId = accountProfileIdSchema.parse(accountProfileId);
    this.#assertOrdinaryAdmission(profileId);
    return runtimeObservation(await this.#ensure(profileId, paths, options, null));
  }

  /**
   * Closed recovery admission for a durable archive authority. Any process
   * generation created through this path is launched without dynamic tools.
   */
  async ensureArchiveRecovery(
    accountProfileId: AccountProfileId,
    paths: RuntimePaths,
    options: AccountRuntimeEnsureOptions,
    archiveHandle: ArchiveAdmissionHandle,
  ): Promise<AccountRuntimeObservation> {
    const profileId = accountProfileIdSchema.parse(accountProfileId);
    const descriptor = this.#archiveAdmissionGate.require(archiveHandle, profileId);
    if (descriptor.cutAuthority !== null && descriptor.successorGeneration === null) {
      throw new ArchiveAdmissionAuthorityError(
        "Archive recovery cannot create a runtime before the cut binds its exact successor generation.",
      );
    }
    const expectedRecoveryGeneration = archiveRecoveryRuntimeGeneration(descriptor);
    const route = this.#routes.get(profileId);
    if (
      descriptor.attemptPhase === "effect_started" &&
      route?.supervisor.current?.generation !== expectedRecoveryGeneration
    ) {
      throw new AccountRuntimeStaleRequestError();
    }
    if (route === undefined) {
      if (options.initialGeneration !== expectedRecoveryGeneration - 1) {
        throw new AccountRuntimeStaleRequestError();
      }
    } else if (route.supervisor.current === null) {
      if (route.supervisor.generation !== expectedRecoveryGeneration - 1) {
        throw new AccountRuntimeStaleRequestError();
      }
    } else if (route.supervisor.current.generation !== expectedRecoveryGeneration) {
      throw new AccountRuntimeStaleRequestError();
    }
    const process = await this.#ensure(profileId, paths, options, archiveHandle);
    this.#archiveAdmissionGate.require(archiveHandle, profileId);
    if (process.generation !== expectedRecoveryGeneration) {
      throw new AccountRuntimeStaleRequestError();
    }
    return runtimeObservation(process);
  }

  async #ensure(
    profileId: AccountProfileId,
    paths: RuntimePaths,
    options: AccountRuntimeEnsureOptions,
    archiveHandle: ArchiveAdmissionHandle | null,
  ): Promise<AccountRuntimeProcess> {
    validateGenerationFloor(options.initialGeneration);
    this.#assertAdmission(profileId, archiveHandle);
    let route = this.#routes.get(profileId);
    if (route !== undefined) {
      const existingRoute = route;
      if (!samePaths(route.paths, paths)) throw new AccountRuntimePathMismatchError();
      if (options.initialGeneration > route.supervisor.generation) {
        throw new AccountRuntimeGenerationFloorMismatchError();
      }
      return await this.#withRouteActivity(existingRoute, async () => {
        this.#assertAdmission(profileId, archiveHandle);
        return await this.#startRoute(existingRoute, archiveHandle);
      });
    }

    const routeReference: { current: AccountRoute | null } = { current: null };
    const supervisor = new CodexRestartSupervisor<AccountRuntimeProcess>({
      beforeCreate: async (generation) => {
        const currentRoute = routeReference.current;
        if (currentRoute === null) {
          throw new Error("Account runtime route was not initialized");
        }
        this.#assertRouteOpen(currentRoute);
        const processArchiveHandle = this.#processCreationArchiveHandle(
          currentRoute,
          generation,
        );
        this.#assertAdmission(profileId, processArchiveHandle);
        await options.beforeCreate(generation);
        this.#assertRouteOpen(currentRoute);
        this.#assertAdmission(profileId, processArchiveHandle);
      },
      create: async (generation) => {
        if (routeReference.current === null) {
          throw new Error("Account runtime route was not initialized");
        }
        return await this.#startProcess(routeReference.current, generation);
      },
      initialGeneration: options.initialGeneration,
      onState: (state) => {
        const currentRoute = routeReference.current;
        if (currentRoute !== null) {
          this.#handleSupervisorState(currentRoute, state);
        }
        const isTerminalProof = state.type === "failed" || state.type === "stopped";
        // Exact terminal lifecycle proof is the sole callback exemption during
        // quarantine or teardown. Starting/running/backoff and every provider
        // callback remain closed once the route is held, stopping, or closed.
        if (
          (
            currentRoute !== null && this.#isRouteOpen(currentRoute) &&
            !this.#archiveAdmissionGate.isHeld(profileId) &&
            !this.#isArchiveQuiescenceInvalidated(currentRoute)
          ) || isTerminalProof
        ) {
          this.#callbacks.onState?.(
            profileId,
            state,
            currentRoute?.stateCause ?? "provider_lifecycle",
          );
        }
      },
      policy: this.#policy,
      ...(this.#restartBudgetResetMs === undefined
        ? {}
        : { restartBudgetResetMs: this.#restartBudgetResetMs }),
      ...(this.#sleep === undefined ? {} : { sleep: this.#sleep }),
    });
    route = {
      activeCallbacks: 0,
      activeOperations: 0,
      activeTurns: new Set(),
      accountProfileId: profileId,
      archiveQuiescenceInvalidatedGeneration: null,
      completedLoginIds: new Set(),
      completedTurns: new Set(),
      expectedThreadArchiveNotifications: new Set(),
      paths,
      processStartAuthority: null,
      pendingServerRequests: new Set(),
      pendingLoginId: null,
      lastUsed: ++this.#routeClock,
      slotHeld: false,
      stateCause: "provider_lifecycle",
      stop: null,
      stopping: false,
      supervisor,
      dynamicToolCapability: null,
      releaseArchiveAdmissionSubscription: null,
    };
    routeReference.current = route;
    route.releaseArchiveAdmissionSubscription = this.#archiveAdmissionGate.subscribe(
      profileId,
      (held) => this.#handleArchiveAdmissionChange(route, held),
    );
    this.#routes.set(profileId, route);
    return await this.#withRouteActivity(route, async () => {
      this.#assertAdmission(profileId, archiveHandle);
      return await this.#startRoute(route, archiveHandle);
    });
  }

  async request<K extends AccountRuntimeRequestKey>(
    accountProfileId: AccountProfileId,
    key: K,
    input: PinnedCodexRequestInput<K>,
    expectedGeneration?: number,
  ): Promise<PinnedCodexRequestOutput<K>> {
    const profileId = accountProfileIdSchema.parse(accountProfileId);
    this.#assertOrdinaryAdmission(profileId);
    const route = this.#routeForRequest(profileId);
    return await this.#withRouteActivity(route, async () => {
      this.#assertOrdinaryAdmission(profileId);
      const process = await this.#processForRequest(route, expectedGeneration);
      this.#assertRouteOpen(route);
      await this.#beforeBoundary({
        accountProfileId: profileId,
        boundary: "request",
        generation: process.generation,
        requestKey: key,
      });
      this.#assertRouteOpen(route);
      this.#assertOrdinaryAdmission(profileId);
      this.#assertRouteOpen(route);
      const output = await process.protocol.request(key, input);
      this.#assertRouteOpen(route);
      this.#assertOrdinaryAdmission(profileId);
      this.#observeRequestOutput(route, key, input, output);
      return output;
    });
  }

  async requestWithResponsePosition<K extends AccountRuntimeRequestKey>(
    accountProfileId: AccountProfileId,
    key: K,
    input: PinnedCodexRequestInput<K>,
    expectedGeneration?: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<K>>> {
    const profileId = accountProfileIdSchema.parse(accountProfileId);
    this.#assertOrdinaryAdmission(profileId);
    const route = this.#routeForRequest(profileId);
    return await this.#withRouteActivity(route, async () => {
      this.#assertOrdinaryAdmission(profileId);
      const process = await this.#processForRequest(route, expectedGeneration);
      this.#assertRouteOpen(route);
      await this.#beforeBoundary({
        accountProfileId: profileId,
        boundary: "request_with_position",
        generation: process.generation,
        requestKey: key,
      });
      this.#assertRouteOpen(route);
      this.#assertOrdinaryAdmission(profileId);
      this.#assertRouteOpen(route);
      const positioned = await process.protocol.requestWithResponsePosition(key, input);
      this.#assertRouteOpen(route);
      this.#assertOrdinaryAdmission(profileId);
      this.#observeRequestOutput(route, key, input, positioned.output);
      return positioned;
    });
  }

  /**
   * Synchronous pre-quarantine seam for live provider-thread transitions.
   * The caller must retain its provisional archive hold in the same JavaScript
   * turn. Ordinary admission checks at every router entry then make the
   * zero-activity observation stable without buffering provider callbacks.
   */
  assertArchiveTransitionQuiescent(
    accountProfileId: AccountProfileId,
    expectedGeneration: number,
  ): void {
    const profileId = accountProfileIdSchema.parse(accountProfileId);
    validateGenerationFloor(expectedGeneration);
    this.#assertOrdinaryAdmission(profileId);
    const route = this.#routeForRequest(profileId);
    this.#assertRouteOpen(route);
    this.#assertArchiveRouteQuiescent(route, expectedGeneration, 0);
    this.#assertOrdinaryAdmission(profileId);
  }

  /**
   * Allows a provisional or durable archive hold to release only while its
   * authorized runtime is still proven idle, or after that generation has
   * terminally stopped. A callback suppressed by quarantine permanently
   * invalidates the live generation's idle proof.
   */
  assertArchiveTransitionProvisionalReleaseSafe(
    accountProfileId: AccountProfileId,
    expectedGeneration: number,
  ): void {
    const profileId = accountProfileIdSchema.parse(accountProfileId);
    validateGenerationFloor(expectedGeneration);
    const route = this.#routes.get(profileId);
    if (route === undefined) return;
    if (route.supervisor.generation > expectedGeneration) return;
    if (route.supervisor.generation < expectedGeneration) {
      throw new AccountRuntimeNotQuiescentError();
    }
    if (
      route.supervisor.current === null && !route.slotHeld &&
      (route.supervisor.state.type === "failed" ||
        route.supervisor.state.type === "stopped")
    ) return;
    this.#assertRouteOpen(route);
    this.#assertArchiveRouteQuiescent(route, expectedGeneration, 0);
  }

  /**
   * The entire archive-recovery provider surface. No unpositioned mutation,
   * responder, or dynamic-tool operation is available to a held authority.
   */
  async requestArchiveRecoveryWithResponsePosition<
    K extends AccountRuntimeArchiveRecoveryRequestKey,
  >(
    accountProfileId: AccountProfileId,
    archiveHandle: ArchiveAdmissionHandle,
    key: K,
    input: PinnedCodexRequestInput<K>,
    expectedGeneration: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<K>>> {
    const profileId = accountProfileIdSchema.parse(accountProfileId);
    this.#assertArchiveRecoveryRequest(
      profileId,
      archiveHandle,
      key,
      input,
      expectedGeneration,
    );
    const route = this.#routeForRequest(profileId);
    const effectClaim: ArchiveAdmissionEffectClaim | null = key === "threadArchive"
      ? this.#archiveAdmissionGate.claimThreadArchiveEffect(archiveHandle)
      : null;
    let effectBegun = false;
    try {
      return await this.#withRouteActivity(route, async () => {
        this.#assertArchiveRecoveryRequest(
          profileId,
          archiveHandle,
          key,
          input,
          expectedGeneration,
        );
        if (effectClaim !== null) {
          this.#archiveAdmissionGate.requireThreadArchiveEffectClaim(effectClaim);
        }
        const process = await this.#processForArchiveRecoveryRequest(
          route,
          archiveHandle,
          key,
          expectedGeneration,
        );
        this.#assertRouteOpen(route);
        await this.#beforeBoundary({
          accountProfileId: profileId,
          boundary: "archive_recovery_request",
          generation: process.generation,
          requestKey: key,
        });
        this.#assertRouteOpen(route);
        this.#assertArchiveRecoveryRequest(
          profileId,
          archiveHandle,
          key,
          input,
          expectedGeneration,
        );
        if (effectClaim !== null) {
          this.#archiveAdmissionGate.requireThreadArchiveEffectClaim(effectClaim);
        }
        if (
          process !== route.supervisor.current ||
          process.generation !== expectedGeneration
        ) throw new AccountRuntimeStaleRequestError();
        this.#assertArchiveRouteQuiescent(route, expectedGeneration, 1);
        if (effectClaim !== null) {
          const threadId = (input as PinnedCodexRequestInput<"threadArchive">)
            .threadId;
          const notificationKey = this.#retainExpectedThreadArchiveNotification(
            route,
            expectedGeneration,
            threadId,
          );
          try {
            this.#archiveAdmissionGate.beginThreadArchiveEffect(effectClaim);
            effectBegun = true;
          } catch (error: unknown) {
            route.expectedThreadArchiveNotifications.delete(notificationKey);
            throw error;
          }
        }
        this.#assertRouteOpen(route);
        const positioned = await process.protocol.requestWithResponsePosition(key, input);
        this.#assertRouteOpen(route);
        if (effectClaim !== null) {
          this.#archiveAdmissionGate.requireThreadArchiveEffectClaim(effectClaim);
        }
        this.#assertArchiveRecoveryRequest(
          profileId,
          archiveHandle,
          key,
          input,
          expectedGeneration,
        );
        if (
          process !== route.supervisor.current ||
          process.generation !== expectedGeneration
        ) throw new AccountRuntimeStaleRequestError();
        // A non-authorized callback may arrive while the provider mutation is
        // in flight. Its held-route rejection taints this generation; never
        // report the archive response as a clean direct outcome in that case.
        this.#assertArchiveRouteQuiescent(route, expectedGeneration, 1);
        this.#observeRequestOutput(route, key, input, positioned.output);
        return positioned;
      });
    } catch (error: unknown) {
      if (effectClaim !== null && !effectBegun) {
        try {
          this.#archiveAdmissionGate.abortThreadArchiveEffectClaim(effectClaim);
        } catch {
          // Replacement or account removal already invalidated the claim.
        }
      }
      throw error;
    }
  }

  #routeForRequest(accountProfileId: AccountProfileId): AccountRoute {
    const profileId = accountProfileIdSchema.parse(accountProfileId);
    const route = this.#routes.get(profileId);
    if (route === undefined) throw new AccountRuntimeNotConfiguredError();
    return route;
  }

  async #processForRequest(
    route: AccountRoute,
    expectedGeneration: number | undefined,
  ): Promise<AccountRuntimeProcess> {
    this.#assertRouteOpen(route);
    if (expectedGeneration !== undefined) {
      validateGenerationFloor(expectedGeneration);
      if (route.supervisor.generation !== expectedGeneration) {
        throw new AccountRuntimeStaleRequestError();
      }
    }
    const process = await this.#startRoute(route, null);
    this.#assertRouteOpen(route);
    if (expectedGeneration !== undefined && process.generation !== expectedGeneration) {
      throw new AccountRuntimeStaleRequestError();
    }
    return process;
  }

  async #processForArchiveRecoveryRequest(
    route: AccountRoute,
    archiveHandle: ArchiveAdmissionHandle,
    key: AccountRuntimeArchiveRecoveryRequestKey,
    expectedGeneration: number,
  ): Promise<AccountRuntimeProcess> {
    this.#assertRouteOpen(route);
    validateGenerationFloor(expectedGeneration);
    const current = route.supervisor.current;
    if (key === "threadArchive") {
      // Once the journal records effect_started, relaunch would move the
      // mutation onto a different process generation. The exact source
      // process must already be live; otherwise containment owns recovery.
      if (
        current === null ||
        current.generation !== expectedGeneration ||
        route.supervisor.generation !== expectedGeneration ||
        route.supervisor.state.type !== "running" ||
        !route.slotHeld
      ) {
        throw new AccountRuntimeStaleRequestError();
      }
      this.#archiveAdmissionGate.require(archiveHandle, route.accountProfileId);
      return current;
    }
    if (current !== null) {
      if (
        current.generation !== expectedGeneration ||
        route.supervisor.generation !== expectedGeneration ||
        route.supervisor.state.type !== "running" ||
        !route.slotHeld
      ) {
        throw new AccountRuntimeStaleRequestError();
      }
      this.#archiveAdmissionGate.require(archiveHandle, route.accountProfileId);
      return current;
    }
    if (
      expectedGeneration === 1 ||
      route.supervisor.generation !== expectedGeneration - 1
    ) {
      throw new AccountRuntimeStaleRequestError();
    }
    const process = await this.#startRoute(route, archiveHandle);
    this.#assertRouteOpen(route);
    if (process.generation !== expectedGeneration) {
      throw new AccountRuntimeStaleRequestError();
    }
    return process;
  }

  async restart(
    accountProfileId: AccountProfileId,
  ): Promise<AccountRuntimeObservation | null> {
    const profileId = accountProfileIdSchema.parse(accountProfileId);
    this.#assertOrdinaryAdmission(profileId);
    const route = this.#routeForRequest(profileId);
    return await this.#withRouteActivity(route, async () => {
      this.#assertOrdinaryAdmission(profileId);
      await this.#reserveRuntimeSlot(route, null);
      this.#assertRouteOpen(route);
      await this.#beforeBoundary({
        accountProfileId: profileId,
        boundary: "restart",
        generation: route.supervisor.generation,
      });
      this.#assertRouteOpen(route);
      this.#assertOrdinaryAdmission(profileId);
      this.#assertRouteOpen(route);
      const restarted = await route.supervisor.restart("restart_requested");
      this.#assertRouteOpen(route);
      this.#assertOrdinaryAdmission(profileId);
      return restarted === null ? null : runtimeObservation(restarted);
    });
  }

  async respond(
    accountProfileId: AccountProfileId,
    request: CodexRespondableServerRequest,
    response: CodexServerResponse,
  ): Promise<CodexStreamPosition | void> {
    const profileId = accountProfileIdSchema.parse(accountProfileId);
    this.#assertOrdinaryAdmission(profileId);
    const route = this.#routeForRequest(profileId);
    return await this.#withRouteActivity(route, async () => {
      this.#assertOrdinaryAdmission(profileId);
      const process = route.supervisor.current;
      if (
        process === null ||
        !this.#ownsPendingServerRequest(route, request) ||
        process.generation !== request.generation
      ) {
        throw new AccountRuntimeStaleRequestError();
      }
      try {
        await this.#beforeBoundary({
          accountProfileId: profileId,
          boundary: "respond",
          generation: process.generation,
        });
        this.#assertRouteOpen(route);
        this.#assertOrdinaryAdmission(profileId);
        if (
          route.supervisor.current !== process ||
          !this.#ownsPendingServerRequest(route, request)
        ) {
          throw new AccountRuntimeStaleRequestError();
        }
        this.#assertRouteOpen(route);
        const position = await process.protocol.respond(request, response);
        this.#assertRouteOpen(route);
        this.#assertOrdinaryAdmission(profileId);
        return position;
      } finally {
        this.#serverRequestOwners.delete(request);
        route.pendingServerRequests.delete(request);
        this.#touchRoute(route);
      }
    });
  }

  async stop(accountProfileId: AccountProfileId): Promise<void> {
    const profileId = accountProfileIdSchema.parse(accountProfileId);
    this.#assertOrdinaryAdmission(profileId);
    const route = this.#routes.get(profileId);
    if (route !== undefined) await this.#stopRoute(route);
  }

  /**
   * Stop only the named runtime generation. A generation change is already a
   * complete fence for the caller's older effect and must never stop the newer
   * process. This seam intentionally does not relaunch; the next ordinary
   * request owns lazy recovery through the durable generation gate.
   */
  async fenceGeneration(
    accountProfileId: AccountProfileId,
    expectedGeneration: number,
  ): Promise<AccountRuntimeFenceResult> {
    const profileId = accountProfileIdSchema.parse(accountProfileId);
    validateGenerationFloor(expectedGeneration);
    const route = this.#routes.get(profileId);
    if (
      route === undefined || route.supervisor.generation !== expectedGeneration ||
      (!route.slotHeld && route.stop === null)
    ) return "already_fenced";
    await this.#stopRoute(route);
    return "fenced";
  }

  /** Exact targetless account-removal fence. No archive RPC authority leaks. */
  async fenceAccountRemovalGeneration(
    accountProfileId: AccountProfileId,
    removalHandle: AccountRemovalAdmissionHandle,
  ): Promise<AccountRuntimeFenceResult> {
    const profileId = accountProfileIdSchema.parse(accountProfileId);
    const descriptor = this.#archiveAdmissionGate.requireAccountRemoval(
      removalHandle,
      profileId,
    );
    const result = await this.fenceGeneration(
      profileId,
      descriptor.expectedGeneration,
    );
    this.#archiveAdmissionGate.requireAccountRemoval(removalHandle, profileId);
    return result;
  }

  async stopAll(): Promise<void> {
    this.#closed = true;
    for (const waiter of this.#admissionQueue) {
      this.#rejectAdmission(waiter);
    }
    this.#notifyCapacityChanged();
    const outcomes = await Promise.allSettled(
      [...this.#routes.values()].map(async (route) =>
        await this.#stopRoute(route, "router_shutdown")
      ),
    );
    for (const route of this.#routes.values()) {
      route.releaseArchiveAdmissionSubscription?.();
      route.releaseArchiveAdmissionSubscription = null;
    }
    const failures: unknown[] = [];
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        const reason: unknown = outcome.reason;
        failures.push(reason);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more account runtimes failed to stop");
    }
  }

  isRunning(accountProfileId: AccountProfileId): boolean {
    const parsed = accountProfileIdSchema.safeParse(accountProfileId);
    if (!parsed.success) return false;
    const supervisor = this.#routes.get(parsed.data)?.supervisor;
    return supervisor?.state.type === "running" && supervisor.current !== null;
  }

  generation(accountProfileId: AccountProfileId): number | null {
    const parsed = accountProfileIdSchema.safeParse(accountProfileId);
    if (!parsed.success) return null;
    return this.#routes.get(parsed.data)?.supervisor.generation ?? null;
  }

  /** Content-free, deterministic inventory for capability reconciliation. */
  configuredAccountProfileIds(): readonly AccountProfileId[] {
    return Object.freeze([...this.#routes.keys()].toSorted());
  }

  supportsDynamicTool(
    accountProfileId: AccountProfileId,
    expectedGeneration?: number,
  ): boolean {
    const parsed = accountProfileIdSchema.safeParse(accountProfileId);
    if (!parsed.success) return false;
    if (
      expectedGeneration !== undefined &&
      (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1)
    ) return false;
    const route = this.#routes.get(parsed.data);
    if (
      route === undefined || !this.#isRouteOpen(route) ||
      this.#archiveAdmissionGate.isHeld(parsed.data) ||
      this.#isArchiveQuiescenceInvalidated(route)
    ) return false;
    const process = route?.supervisor.current ?? null;
    const capability = route?.dynamicToolCapability ?? null;
    if (
      route === undefined ||
      process === null ||
      route.supervisor.state.type !== "running" ||
      capability === null ||
      capability.caller.accountProfileId !== route.accountProfileId ||
      capability.caller.accountGeneration !== route.supervisor.generation ||
      capability.witness.processGeneration !== route.supervisor.generation ||
      process.generation !== route.supervisor.generation
    ) return false;
    return expectedGeneration === undefined ||
      expectedGeneration === capability.caller.accountGeneration;
  }

  /**
   * Returns the exact verified capability retained for the live process.
   * Callers must still bind its account and generation to their own durable
   * actor authority; this method never selects an account on their behalf.
   */
  readDynamicToolCapability(
    accountProfileId: AccountProfileId,
    expectedGeneration: number,
  ): PinnedCodexDynamicToolProtocolCapability | null {
    const profileId = accountProfileIdSchema.safeParse(accountProfileId);
    if (
      !profileId.success ||
      !Number.isSafeInteger(expectedGeneration) ||
      expectedGeneration < 1 ||
      this.#closed ||
      this.#archiveAdmissionGate.isHeld(profileId.data) ||
      !this.supportsDynamicTool(profileId.data, expectedGeneration)
    ) return null;
    const capability = this.#routes.get(profileId.data)?.dynamicToolCapability ?? null;
    return capability?.caller.accountGeneration === expectedGeneration
      ? capability
      : null;
  }

  async #startRoute(
    route: AccountRoute,
    archiveHandle: ArchiveAdmissionHandle | null,
  ): Promise<AccountRuntimeProcess> {
    this.#assertRouteOpen(route);
    this.#assertAdmission(route.accountProfileId, archiveHandle);
    await this.#reserveRuntimeSlot(route, archiveHandle);
    this.#assertRouteOpen(route);
    this.#assertAdmission(route.accountProfileId, archiveHandle);
    const startAuthority = Object.freeze({
      archiveHandle,
      generation: archiveHandle === null
        ? route.supervisor.current?.generation ?? route.supervisor.generation + 1
        : archiveRecoveryRuntimeGeneration(this.#archiveAdmissionGate.require(
            archiveHandle,
            route.accountProfileId,
          )),
    });
    const ownsStartAuthority = route.processStartAuthority === null;
    if (ownsStartAuthority) route.processStartAuthority = startAuthority;
    try {
      this.#assertRouteOpen(route);
      this.#assertAdmission(route.accountProfileId, archiveHandle);
      const process = await route.supervisor.start();
      this.#assertRouteOpen(route);
      this.#assertAdmission(route.accountProfileId, archiveHandle);
      if (!route.slotHeld) {
        await route.supervisor.stop();
        throw new AccountRuntimeCapacityError();
      }
      this.#touchRoute(route);
      return process;
    } catch (error: unknown) {
      if (
        route.supervisor.current === null &&
        (route.supervisor.state.type === "failed" ||
          route.supervisor.state.type === "stopped")
      ) {
        this.#releaseRuntimeSlot(route);
      }
      throw error;
    } finally {
      if (ownsStartAuthority && route.processStartAuthority === startAuthority) {
        route.processStartAuthority = null;
      }
    }
  }

  async #withRouteActivity<T>(
    route: AccountRoute,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.#assertRouteOpen(route);
    route.activeOperations += 1;
    this.#touchRoute(route);
    let outcome:
      | { readonly status: "fulfilled"; readonly value: T }
      | { readonly reason: unknown; readonly status: "rejected" };
    try {
      const value = await operation();
      this.#assertRouteOpen(route);
      outcome = { status: "fulfilled", value };
    } catch (reason: unknown) {
      outcome = { status: "rejected", reason };
    }
    route.activeOperations -= 1;
    if (route.activeOperations < 0) {
      route.activeOperations = 0;
      throw new Error("Account runtime activity accounting underflowed");
    }
    this.#touchRoute(route);
    if (outcome.status === "rejected") throw outcome.reason;
    return outcome.value;
  }

  async #reserveRuntimeSlot(
    route: AccountRoute,
    archiveHandle: ArchiveAdmissionHandle | null,
  ): Promise<void> {
    this.#assertRouteOpen(route);
    await this.#beforeBoundary({
      accountProfileId: route.accountProfileId,
      boundary: "capacity_admission",
      generation: route.supervisor.generation,
    });
    this.#assertRouteOpen(route);
    this.#assertAdmission(route.accountProfileId, archiveHandle);
    if (route.slotHeld) return;
    this.#assertRouteOpen(route);
    const admission = new Promise<void>((resolve, reject) => {
      const waiter: RuntimeAdmissionWaiter = {
        archiveHandle,
        deadline: performance.now() + this.#admissionTimeoutMs,
        reject,
        resolve,
        route,
        settled: false,
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        this.#rejectAdmission(waiter);
        this.#notifyCapacityChanged();
        this.#scheduleAdmissionDrain();
      }, this.#admissionTimeoutMs);
      this.#admissionQueue.push(waiter);
      this.#scheduleAdmissionDrain();
    });
    await admission;
    this.#assertRouteOpen(route);
    this.#assertAdmission(route.accountProfileId, archiveHandle);
  }

  #scheduleAdmissionDrain(): void {
    if (this.#admissionProcessing) return;
    this.#admissionProcessing = true;
    void this.#drainAdmissionQueue().finally(() => {
      this.#admissionProcessing = false;
      if (this.#admissionQueue.some((waiter) => !waiter.settled)) {
        this.#scheduleAdmissionDrain();
      }
    });
  }

  async #drainAdmissionQueue(): Promise<void> {
    for (;;) {
      const waiter = this.#admissionQueue[0];
      if (waiter === undefined) return;
      if (waiter.settled) {
        this.#admissionQueue.shift();
        continue;
      }
      if (
        this.#closed || waiter.route.stopping ||
        performance.now() >= waiter.deadline
      ) {
        this.#rejectAdmission(waiter);
        continue;
      }
      try {
        this.#assertAdmission(
          waiter.route.accountProfileId,
          waiter.archiveHandle,
        );
      } catch (error: unknown) {
        this.#rejectAdmission(
          waiter,
          error instanceof Error
            ? error
            : new ArchiveAdmissionAuthorityError(),
        );
        continue;
      }
      if (waiter.route.slotHeld) {
        this.#resolveAdmission(waiter);
        continue;
      }
      if (this.#liveRuntimeSlotCount() < this.#maximumLiveProcesses) {
        waiter.route.slotHeld = true;
        this.#touchRoute(waiter.route);
        this.#resolveAdmission(waiter);
        continue;
      }
      const candidate = this.#idleEvictionCandidate(waiter.route);
      if (candidate !== null) {
        try {
          await this.#stopRoute(candidate, "capacity_evicted");
        } catch {
          // Supervisor stop fences the process before reporting cleanup detail.
        }
        continue;
      }
      const generation = this.#capacityGeneration;
      await this.#waitForCapacityChange(generation);
    }
  }

  #resolveAdmission(waiter: RuntimeAdmissionWaiter): void {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.timer !== null) clearTimeout(waiter.timer);
    waiter.resolve();
  }

  #rejectAdmission(
    waiter: RuntimeAdmissionWaiter,
    error: Error = new AccountRuntimeCapacityError(),
  ): void {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.timer !== null) clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  #cancelRouteAdmission(route: AccountRoute): void {
    for (const waiter of this.#admissionQueue) {
      if (waiter.route === route) this.#rejectAdmission(waiter);
    }
    this.#notifyCapacityChanged();
  }

  #cancelOrdinaryRouteAdmission(route: AccountRoute): void {
    for (const waiter of this.#admissionQueue) {
      if (waiter.route === route && waiter.archiveHandle === null) {
        try {
          this.#assertOrdinaryAdmission(
            route.accountProfileId,
          );
        } catch (error: unknown) {
          this.#rejectAdmission(
            waiter,
            error instanceof Error ? error : new ArchiveAdmissionAuthorityError(),
          );
        }
      }
    }
    this.#notifyCapacityChanged();
  }

  #liveRuntimeSlotCount(): number {
    let count = 0;
    for (const route of this.#routes.values()) {
      if (route.slotHeld) count += 1;
    }
    return count;
  }

  #idleEvictionCandidate(excluded: AccountRoute): AccountRoute | null {
    let candidate: AccountRoute | null = null;
    for (const route of this.#routes.values()) {
      if (
        route === excluded || !route.slotHeld || route.stopping ||
        this.#archiveAdmissionGate.isHeld(route.accountProfileId) ||
        route.activeCallbacks !== 0 || route.activeOperations !== 0 ||
        route.activeTurns.size !== 0 ||
        route.pendingServerRequests.size !== 0 || route.pendingLoginId !== null ||
        route.supervisor.current === null || route.supervisor.state.type !== "running"
      ) continue;
      if (
        candidate === null || route.lastUsed < candidate.lastUsed ||
        (
          route.lastUsed === candidate.lastUsed &&
          route.accountProfileId.localeCompare(candidate.accountProfileId) < 0
        )
      ) candidate = route;
    }
    return candidate;
  }

  #waitForCapacityChange(observedGeneration: number): Promise<number> {
    if (this.#capacityGeneration !== observedGeneration) {
      return Promise.resolve(this.#capacityGeneration);
    }
    if (this.#capacityWait === null) {
      let resolve!: (generation: number) => void;
      const promise = new Promise<number>((resolvePromise) => {
        resolve = resolvePromise;
      });
      this.#capacityWait = { promise, resolve };
    }
    return this.#capacityWait.promise;
  }

  #notifyCapacityChanged(): void {
    this.#capacityGeneration += 1;
    const wait = this.#capacityWait;
    this.#capacityWait = null;
    wait?.resolve(this.#capacityGeneration);
  }

  #releaseRuntimeSlot(route: AccountRoute): void {
    if (!route.slotHeld) return;
    route.slotHeld = false;
    route.dynamicToolCapability = null;
    this.#notifyCapacityChanged();
    this.#scheduleAdmissionDrain();
  }

  #stopRoute(
    route: AccountRoute,
    cause: Exclude<AccountRuntimeStateCause, "provider_lifecycle"> = "explicit_stop",
  ): Promise<void> {
    if (route.stop !== null) {
      // Capacity eviction is opportunistic. A concurrent intentional stop or
      // global shutdown owns the externally observed reason without starting
      // a second process teardown.
      if (route.stateCause === "capacity_evicted" && cause !== "capacity_evicted") {
        route.stateCause = cause;
      }
      return route.stop;
    }
    const stop = this.#stopRouteOnce(route, cause);
    route.stop = stop;
    void stop.finally(() => {
      if (route.stop === stop) route.stop = null;
    }).catch(() => undefined);
    return stop;
  }

  async #stopRouteOnce(
    route: AccountRoute,
    cause: Exclude<AccountRuntimeStateCause, "provider_lifecycle">,
  ): Promise<void> {
    route.stateCause = cause;
    route.stopping = true;
    this.#cancelRouteAdmission(route);
    try {
      await route.supervisor.stop();
    } finally {
      this.#clearGenerationActivity(route);
      this.#releaseRuntimeSlot(route);
      if (route.stateCause !== "router_shutdown") {
        route.stateCause = "provider_lifecycle";
        route.stopping = false;
      }
    }
  }

  #handleSupervisorState(route: AccountRoute, state: CodexSupervisorState): void {
    if (
      state.type === "starting" || state.type === "backing_off" ||
      state.type === "failed" || state.type === "stopped"
    ) {
      this.#clearGenerationActivity(route);
    }
    if (state.type === "failed" || state.type === "stopped") {
      this.#releaseRuntimeSlot(route);
    }
  }

  #clearGenerationActivity(route: AccountRoute): void {
    route.activeTurns.clear();
    route.completedLoginIds.clear();
    route.completedTurns.clear();
    route.expectedThreadArchiveNotifications.clear();
    route.pendingLoginId = null;
    for (const request of route.pendingServerRequests) {
      this.#serverRequestOwners.delete(request);
    }
    route.pendingServerRequests.clear();
    if (route.activeCallbacks === 0) {
      route.archiveQuiescenceInvalidatedGeneration = null;
    }
    this.#touchRoute(route);
  }

  #touchRoute(route: AccountRoute): void {
    route.lastUsed = ++this.#routeClock;
    if (
      route.activeCallbacks === 0 && route.activeOperations === 0 &&
      route.activeTurns.size === 0 &&
      route.pendingServerRequests.size === 0 && route.pendingLoginId === null
    ) {
      this.#notifyCapacityChanged();
    }
  }

  #observeRequestOutput<K extends AccountRuntimeRequestKey>(
    route: AccountRoute,
    key: K,
    input: PinnedCodexRequestInput<K>,
    output: PinnedCodexRequestOutput<K>,
  ): void {
    if (key === "accountLoginStart") {
      const login = output as PinnedCodexRequestOutput<"accountLoginStart">;
      route.pendingLoginId = login.type === "chatgpt" ||
          login.type === "chatgptDeviceCode"
        ? route.completedLoginIds.has(login.loginId) ? null : login.loginId
        : null;
    } else if (key === "accountLoginCancel") {
      const cancel = input as PinnedCodexRequestInput<"accountLoginCancel">;
      if (route.pendingLoginId === cancel.loginId) route.pendingLoginId = null;
    } else if (key === "accountLogout") {
      route.pendingLoginId = null;
    } else if (key === "turnStart") {
      const startInput = input as PinnedCodexRequestInput<"turnStart">;
      const start = output as PinnedCodexRequestOutput<"turnStart">;
      const turnKey = runtimeTurnKey(startInput.threadId, start.turn.id);
      if (start.turn.status === "inProgress" && !route.completedTurns.has(turnKey)) {
        route.activeTurns.add(turnKey);
      }
    } else if (
      key === "threadStart" || key === "threadResume" ||
      key === "threadRead" || key === "threadFork"
    ) {
      const thread = (output as PinnedCodexRequestOutput<"threadRead">).thread;
      for (const turn of thread.turns) {
        this.#observeTurnSnapshot(route, thread.id, turn);
      }
    } else if (key === "threadTurnsList") {
      const listInput = input as PinnedCodexRequestInput<"threadTurnsList">;
      const list = output as PinnedCodexRequestOutput<"threadTurnsList">;
      for (const turn of list.data) {
        this.#observeTurnSnapshot(route, listInput.threadId, turn);
      }
    }
    this.#touchRoute(route);
  }

  #observeTurnSnapshot(
    route: AccountRoute,
    threadId: string,
    turn: PinnedCodexRequestOutput<"turnStart">["turn"],
  ): void {
    const turnKey = runtimeTurnKey(threadId, turn.id);
    if (turn.status === "inProgress") {
      if (!route.completedTurns.has(turnKey)) route.activeTurns.add(turnKey);
      return;
    }
    retainCompletedTurn(route.completedTurns, turnKey);
    route.activeTurns.delete(turnKey);
  }

  #removeExpiredServerRequest(
    route: AccountRoute,
    fault: CodexExpiredServerRequestFault,
  ): void {
    for (const request of route.pendingServerRequests) {
      if (
        request.generation === fault.generation &&
        (fault.requestId === undefined ||
          (request.id === fault.requestId && request.method === fault.method))
      ) {
        route.pendingServerRequests.delete(request);
        this.#serverRequestOwners.delete(request);
      }
    }
  }

  #forgetPendingServerRequest(
    route: AccountRoute,
    request: CodexRespondableServerRequest,
  ): void {
    this.#serverRequestOwners.delete(request);
    route.pendingServerRequests.delete(request);
    this.#touchRoute(route);
  }

  #ownsPendingServerRequest(
    route: AccountRoute,
    request: CodexRespondableServerRequest,
  ): boolean {
    const owner = this.#serverRequestOwners.get(request);
    return this.#isRouteOpen(route) &&
      !this.#archiveAdmissionGate.isHeld(route.accountProfileId) &&
      !this.#isArchiveQuiescenceInvalidated(route) &&
      this.#isCurrentGeneration(route.accountProfileId, request.generation) &&
      route.pendingServerRequests.has(request) &&
      owner?.accountProfileId === route.accountProfileId &&
      owner.generation === request.generation &&
      route.supervisor.current === owner.process &&
      owner.process.generation === request.generation;
  }

  #acceptedCallbackProcess(
    route: AccountRoute,
    callbackAuthority: ProcessCallbackAuthority,
    eventGeneration: number,
  ): AccountRuntimeProcess | null {
    const process = this.#currentCallbackProcess(
      route,
      callbackAuthority,
      eventGeneration,
    );
    if (
      process === null ||
      this.#archiveAdmissionGate.isHeld(route.accountProfileId) ||
      this.#isArchiveQuiescenceInvalidated(route)
    ) return null;
    return process;
  }

  #currentCallbackProcess(
    route: AccountRoute,
    callbackAuthority: ProcessCallbackAuthority,
    eventGeneration: number,
  ): AccountRuntimeProcess | null {
    const process = callbackAuthority.process;
    if (
      process === null ||
      !this.#isRouteOpen(route) ||
      this.#routes.get(route.accountProfileId) !== route ||
      route.supervisor.current !== process ||
      route.supervisor.state.type !== "running" ||
      route.supervisor.generation !== callbackAuthority.generation ||
      process.generation !== callbackAuthority.generation ||
      eventGeneration !== callbackAuthority.generation
    ) return null;
    return process;
  }

  #invalidateArchiveQuiescenceForHeldCallback(
    route: AccountRoute,
    callbackAuthority: ProcessCallbackAuthority,
    eventGeneration: number,
  ): void {
    if (
      !this.#archiveAdmissionGate.isHeld(route.accountProfileId) ||
      this.#currentCallbackProcess(
        route,
        callbackAuthority,
        eventGeneration,
      ) === null
    ) return;
    route.archiveQuiescenceInvalidatedGeneration = eventGeneration;
    this.#touchRoute(route);
  }

  #retainExpectedThreadArchiveNotification(
    route: AccountRoute,
    generation: number,
    threadId: string,
  ): string {
    const key = expectedThreadArchiveNotificationKey(generation, threadId);
    if (
      !route.expectedThreadArchiveNotifications.has(key) &&
      route.expectedThreadArchiveNotifications.size >=
        maximumExpectedThreadArchiveNotificationTombstones
    ) {
      throw new AccountRuntimeNotQuiescentError();
    }
    route.expectedThreadArchiveNotifications.add(key);
    return key;
  }

  #consumeExpectedThreadArchiveNotification(
    route: AccountRoute,
    callbackAuthority: ProcessCallbackAuthority,
    notification: CodexNotification,
  ): boolean {
    if (
      notification.method !== "thread/archived" ||
      this.#currentCallbackProcess(
        route,
        callbackAuthority,
        notification.generation,
      ) === null
    ) return false;
    const key = expectedThreadArchiveNotificationKey(
      notification.generation,
      notification.params.threadId,
    );
    if (!route.expectedThreadArchiveNotifications.delete(key)) return false;
    this.#touchRoute(route);
    return true;
  }

  async #withProviderCallbackActivity<T>(
    route: AccountRoute,
    operation: () => Promise<T>,
  ): Promise<T> {
    route.activeCallbacks += 1;
    this.#touchRoute(route);
    let outcome:
      | { readonly status: "fulfilled"; readonly value: T }
      | { readonly reason: unknown; readonly status: "rejected" };
    try {
      outcome = { status: "fulfilled", value: await operation() };
    } catch (reason: unknown) {
      outcome = { reason, status: "rejected" };
    }
    route.activeCallbacks -= 1;
    if (route.activeCallbacks < 0) {
      route.activeCallbacks = 0;
      throw new Error("Account runtime callback activity accounting underflowed");
    }
    this.#clearTerminalArchiveQuiescenceInvalidation(route);
    this.#touchRoute(route);
    if (outcome.status === "rejected") throw outcome.reason;
    return outcome.value;
  }

  #clearTerminalArchiveQuiescenceInvalidation(route: AccountRoute): void {
    const invalidatedGeneration = route.archiveQuiescenceInvalidatedGeneration;
    if (invalidatedGeneration === null || route.activeCallbacks !== 0) return;
    if (
      route.supervisor.generation !== invalidatedGeneration ||
      (
        route.supervisor.current === null && !route.slotHeld &&
        (route.supervisor.state.type === "failed" ||
          route.supervisor.state.type === "stopped")
      )
    ) {
      route.archiveQuiescenceInvalidatedGeneration = null;
    }
  }

  async #startProcess(
    route: AccountRoute,
    generation: number,
  ): Promise<AccountRuntimeProcess> {
    this.#assertRouteOpen(route);
    if (!route.slotHeld) throw new AccountRuntimeCapacityError();
    const archiveHandle = this.#processCreationArchiveHandle(route, generation);
    const callbackAuthority: ProcessCallbackAuthority = {
      generation,
      process: null,
    };
    let dynamicToolCapability: PinnedCodexDynamicToolProtocolCapability | null = null;
    if (archiveHandle === null) {
      this.#assertRouteOpen(route);
      await this.#beforeBoundary({
        accountProfileId: route.accountProfileId,
        boundary: "dynamic_tool_capability",
        generation,
      });
      this.#assertRouteOpen(route);
      this.#assertOrdinaryAdmission(route.accountProfileId);
      this.#assertRouteOpen(route);
      dynamicToolCapability = await this.#resolveDynamicToolCapability(
        route,
        generation,
      );
      this.#assertRouteOpen(route);
      this.#assertOrdinaryAdmission(route.accountProfileId);
    }
    this.#assertRouteOpen(route);
    await this.#beforeBoundary({
      accountProfileId: route.accountProfileId,
      boundary: "process_creation",
      generation,
    });
    this.#assertRouteOpen(route);
    this.#assertAdmission(route.accountProfileId, archiveHandle);
    this.#assertRouteOpen(route);
    const process = await this.#createProcess({
      accountProfileId: route.accountProfileId,
      callbacks: this.#scopedCallbacks(route, callbackAuthority),
      dynamicToolCapability,
      generation,
      paths: route.paths,
    });
    try {
      this.#assertRouteOpen(route);
      this.#assertAdmission(route.accountProfileId, archiveHandle);
    } catch (error: unknown) {
      await process.expire("stopped");
      throw error;
    }
    callbackAuthority.process = process;
    route.dynamicToolCapability = dynamicToolCapability;
    void process.faulted.then((reason) => {
      if (
        this.#closed || route.stopping || !route.slotHeld ||
        this.#archiveAdmissionGate.isHeld(route.accountProfileId) ||
        this.#isArchiveQuiescenceInvalidated(route) ||
        route.supervisor.current !== process ||
        !this.#isCurrentGeneration(route.accountProfileId, generation)
      ) return;
      void route.supervisor.restart(reason, generation);
    });
    return process;
  }

  #scopedCallbacks(
    route: AccountRoute,
    callbackAuthority: ProcessCallbackAuthority,
  ): CodexRpcCallbacks {
    const accountProfileId = route.accountProfileId;
    const onDynamicToolRequest = this.#callbacks.onDynamicToolRequest;
    return {
      onNotification: async (notification) => {
        if (this.#consumeExpectedThreadArchiveNotification(
          route,
          callbackAuthority,
          notification,
        )) return;
        this.#invalidateArchiveQuiescenceForHeldCallback(
          route,
          callbackAuthority,
          notification.generation,
        );
        if (this.#acceptedCallbackProcess(
          route,
          callbackAuthority,
          notification.generation,
        ) === null) return;
        await this.#withProviderCallbackActivity(route, async () => {
          const turnKey = notification.method === "turn/started" ||
              notification.method === "turn/completed"
            ? runtimeTurnKey(
                notification.params.threadId,
                notification.params.turn.id,
              )
            : null;
          if (
            notification.method === "turn/started" && turnKey !== null &&
            !route.completedTurns.has(turnKey)
          ) {
            route.activeTurns.add(turnKey);
          }
          if (notification.method === "account/login/completed") {
            if (notification.params.loginId !== null) {
              retainBoundedIdentity(
                route.completedLoginIds,
                notification.params.loginId,
                maximumCompletedLoginTombstones,
              );
            }
            if (route.pendingLoginId === notification.params.loginId) {
              route.pendingLoginId = null;
            }
          }
          if (notification.method === "turn/completed" && turnKey !== null) {
            retainCompletedTurn(route.completedTurns, turnKey);
          }
          try {
            if (this.#acceptedCallbackProcess(
              route,
              callbackAuthority,
              notification.generation,
            ) === null) return;
            await this.#callbacks.onNotification?.(accountProfileId, notification);
            if (this.#acceptedCallbackProcess(
              route,
              callbackAuthority,
              notification.generation,
            ) === null) return;
          } finally {
            if (notification.method === "turn/completed" && turnKey !== null) {
              route.activeTurns.delete(turnKey);
              this.#touchRoute(route);
            }
          }
        });
      },
      onServerRequest: async (request) => {
        this.#invalidateArchiveQuiescenceForHeldCallback(
          route,
          callbackAuthority,
          request.generation,
        );
        const callbackProcess = this.#acceptedCallbackProcess(
          route,
          callbackAuthority,
          request.generation,
        );
        if (callbackProcess === null) return;
        await this.#withProviderCallbackActivity(route, async () => {
          this.#serverRequestOwners.set(request, {
            accountProfileId,
            generation: request.generation,
            process: callbackProcess,
          });
          route.pendingServerRequests.add(request);
          this.#touchRoute(route);
          if (this.#acceptedCallbackProcess(
            route,
            callbackAuthority,
            request.generation,
          ) !== callbackProcess) {
            this.#forgetPendingServerRequest(route, request);
            return;
          }
          await this.#beforeBoundary({
            accountProfileId,
            boundary: "callback_dispatch",
            generation: request.generation,
          });
          if (
            this.#acceptedCallbackProcess(
              route,
              callbackAuthority,
              request.generation,
            ) !== callbackProcess ||
            !this.#ownsPendingServerRequest(route, request)
          ) {
            this.#forgetPendingServerRequest(route, request);
            return;
          }
          if (
            this.#acceptedCallbackProcess(
              route,
              callbackAuthority,
              request.generation,
            ) !== callbackProcess ||
            !this.#ownsPendingServerRequest(route, request)
          ) return;
          await this.#callbacks.onServerRequest?.(accountProfileId, request);
          if (this.#acceptedCallbackProcess(
            route,
            callbackAuthority,
            request.generation,
          ) !== callbackProcess) return;
        });
      },
      ...(onDynamicToolRequest === undefined
        ? {}
        : {
          onDynamicToolRequest: async (request: PinnedCodexDynamicToolRequest) => {
            this.#invalidateArchiveQuiescenceForHeldCallback(
              route,
              callbackAuthority,
              request.generation,
            );
            const callbackProcess = this.#acceptedCallbackProcess(
              route,
              callbackAuthority,
              request.generation,
            );
            if (callbackProcess === null) return;
            await this.#withProviderCallbackActivity(route, async () => {
              this.#serverRequestOwners.set(request, {
                accountProfileId,
                generation: request.generation,
                process: callbackProcess,
              });
              route.pendingServerRequests.add(request);
              this.#touchRoute(route);
              if (this.#acceptedCallbackProcess(
                route,
                callbackAuthority,
                request.generation,
              ) !== callbackProcess) {
                this.#forgetPendingServerRequest(route, request);
                return;
              }
              await this.#beforeBoundary({
                accountProfileId,
                boundary: "callback_dispatch",
                generation: request.generation,
              });
              if (
                this.#acceptedCallbackProcess(
                  route,
                  callbackAuthority,
                  request.generation,
                ) !== callbackProcess ||
                !this.#ownsPendingServerRequest(route, request)
              ) {
                this.#forgetPendingServerRequest(route, request);
                return;
              }
              if (
                this.#acceptedCallbackProcess(
                  route,
                  callbackAuthority,
                  request.generation,
                ) !== callbackProcess ||
                !this.#ownsPendingServerRequest(route, request)
              ) return;
              await onDynamicToolRequest(accountProfileId, request);
              if (this.#acceptedCallbackProcess(
                route,
                callbackAuthority,
                request.generation,
              ) !== callbackProcess) return;
            });
          },
        }),
      onDiagnostic: async (diagnostic) => {
        this.#invalidateArchiveQuiescenceForHeldCallback(
          route,
          callbackAuthority,
          diagnostic.generation,
        );
        if (this.#acceptedCallbackProcess(
          route,
          callbackAuthority,
          diagnostic.generation,
        ) === null) return;
        await this.#withProviderCallbackActivity(route, async () => {
          if (this.#acceptedCallbackProcess(
            route,
            callbackAuthority,
            diagnostic.generation,
          ) === null) return;
          await this.#callbacks.onDiagnostic?.(accountProfileId, diagnostic);
          if (this.#acceptedCallbackProcess(
            route,
            callbackAuthority,
            diagnostic.generation,
          ) === null) return;
        });
      },
      onServerRequestExpired: async (fault) => {
        this.#invalidateArchiveQuiescenceForHeldCallback(
          route,
          callbackAuthority,
          fault.generation,
        );
        if (this.#acceptedCallbackProcess(
          route,
          callbackAuthority,
          fault.generation,
        ) === null) return;
        await this.#withProviderCallbackActivity(route, async () => {
          this.#removeExpiredServerRequest(route, fault);
          this.#touchRoute(route);
          if (this.#acceptedCallbackProcess(
            route,
            callbackAuthority,
            fault.generation,
          ) === null) return;
          await this.#callbacks.onServerRequestExpired?.(accountProfileId, fault);
          if (this.#acceptedCallbackProcess(
            route,
            callbackAuthority,
            fault.generation,
          ) === null) return;
        });
      },
    };
  }

  async #resolveDynamicToolCapability(
    route: AccountRoute,
    generation: number,
  ): Promise<PinnedCodexDynamicToolProtocolCapability | null> {
    const resolver = this.#dynamicToolCapability;
    if (resolver === null) return null;
    let capability: PinnedCodexDynamicToolProtocolCapability | null;
    try {
      capability = await resolver({
        accountProfileId: route.accountProfileId,
        generation,
        paths: route.paths,
      });
    } catch {
      return null;
    }
    if (
      capability === null ||
      capability.caller.accountProfileId !== route.accountProfileId ||
      capability.caller.accountGeneration !== generation ||
      capability.runtimeBinarySha256 !== capability.witness.binarySha256 ||
      !isPinnedCodexDynamicToolProbeWitness(capability.witness, {
        binarySha256: capability.runtimeBinarySha256,
        processGeneration: generation,
        nowMs: this.#now(),
      })
    ) {
      return null;
    }
    return capability;
  }

  #assertAdmission(
    accountProfileId: AccountProfileId,
    archiveHandle: ArchiveAdmissionHandle | null,
  ): void {
    if (archiveHandle === null) {
      this.#assertOrdinaryAdmission(accountProfileId);
      return;
    }
    this.#archiveAdmissionGate.require(archiveHandle, accountProfileId);
  }

  #assertOrdinaryAdmission(accountProfileId: AccountProfileId): void {
    this.#archiveAdmissionGate.assertOrdinaryAdmission(accountProfileId);
    const route = this.#routes.get(accountProfileId);
    if (route !== undefined && this.#isArchiveQuiescenceInvalidated(route)) {
      throw new AccountRuntimeNotQuiescentError();
    }
  }

  #isArchiveQuiescenceInvalidated(route: AccountRoute): boolean {
    return route.archiveQuiescenceInvalidatedGeneration !== null;
  }

  #assertArchiveRouteQuiescent(
    route: AccountRoute,
    expectedGeneration: number,
    expectedActiveOperations: number,
  ): void {
    const process = route.supervisor.current;
    if (
      process === null ||
      !route.slotHeld ||
      route.supervisor.state.type !== "running" ||
      route.supervisor.generation !== expectedGeneration ||
      process.generation !== expectedGeneration ||
      route.processStartAuthority !== null ||
      route.activeCallbacks !== 0 ||
      route.activeOperations !== expectedActiveOperations ||
      route.activeTurns.size !== 0 ||
      route.pendingServerRequests.size !== 0 ||
      route.pendingLoginId !== null ||
      route.archiveQuiescenceInvalidatedGeneration !== null
    ) {
      throw new AccountRuntimeNotQuiescentError();
    }
  }

  #assertArchiveRecoveryRequest<K extends AccountRuntimeArchiveRecoveryRequestKey>(
    accountProfileId: AccountProfileId,
    archiveHandle: ArchiveAdmissionHandle,
    key: K,
    input: PinnedCodexRequestInput<K>,
    expectedGeneration: number,
  ): ArchiveAdmissionDescriptor {
    const descriptor = this.#archiveAdmissionGate.require(
      archiveHandle,
      accountProfileId,
    );
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
      throw new ArchiveAdmissionAuthorityError(
        "The provider archive recovery generation is invalid.",
      );
    }
    if (key === "threadArchive") {
      const threadId = (input as PinnedCodexRequestInput<"threadArchive">).threadId;
      if (
        descriptor.attemptPhase !== "effect_started" ||
        descriptor.cutAuthority !== null ||
        expectedGeneration !== descriptor.expectedGeneration ||
        archiveRestartThreadDigest(threadId) !== descriptor.restartThreadDigest
      ) {
        throw new ArchiveAdmissionAuthorityError(
          "The provider archive mutation does not match its exact registered authority.",
        );
      }
      return descriptor;
    }
    if (
      key !== "threadList" ||
      descriptor.attemptPhase !== "ambiguous" ||
      descriptor.cutAuthority === null ||
      descriptor.successorGeneration === null ||
      descriptor.successorGeneration <= descriptor.expectedGeneration ||
      expectedGeneration !== descriptor.successorGeneration
    ) {
      throw new ArchiveAdmissionAuthorityError(
        "Provider archive reconciliation requires an exact cut and strict successor generation.",
      );
    }
    return descriptor;
  }

  #processCreationArchiveHandle(
    route: AccountRoute,
    generation: number,
  ): ArchiveAdmissionHandle | null {
    const authority = route.processStartAuthority;
    if (this.#archiveAdmissionGate.isHeld(route.accountProfileId)) {
      const archiveHandle = authority?.archiveHandle ?? null;
      if (archiveHandle !== null && authority?.generation === generation) {
        const descriptor = this.#archiveAdmissionGate.require(
          archiveHandle,
          route.accountProfileId,
        );
        if (archiveRecoveryRuntimeGeneration(descriptor) === generation) {
          return archiveHandle;
        }
      }
      throw new ArchiveAdmissionAuthorityError(
        "Process creation requires an exact active provider archive authority.",
      );
    }
    if (authority !== null && authority.archiveHandle !== null) {
      throw new ArchiveAdmissionAuthorityError(
        "A released provider archive authority cannot create a process.",
      );
    }
    return null;
  }

  #handleArchiveAdmissionChange(route: AccountRoute, held: boolean): void {
    if (held) {
      if (
        route.activeCallbacks !== 0 || route.activeOperations !== 0 ||
        route.activeTurns.size !== 0 ||
        route.pendingServerRequests.size !== 0 ||
        route.pendingLoginId !== null
      ) {
        route.archiveQuiescenceInvalidatedGeneration =
          route.supervisor.generation;
      }
      this.#cancelOrdinaryRouteAdmission(route);
      for (const request of route.pendingServerRequests) {
        this.#serverRequestOwners.delete(request);
      }
      route.pendingServerRequests.clear();
      this.#touchRoute(route);
    }
    this.#notifyCapacityChanged();
    this.#scheduleAdmissionDrain();
  }

  async #beforeBoundary(input: AccountRuntimeRouterBoundaryInput): Promise<void> {
    await this.#testHooks.beforeBoundary?.(Object.freeze(input));
  }

  #assertRouteOpen(route: AccountRoute): void {
    if (!this.#isRouteOpen(route)) throw new AccountRuntimeCapacityError();
  }

  #isRouteOpen(route: AccountRoute): boolean {
    return !this.#closed && !route.stopping;
  }

  #isCurrentGeneration(
    accountProfileId: AccountProfileId,
    generation: number,
  ): boolean {
    const route = this.#routes.get(accountProfileId);
    return route !== undefined && route.supervisor.generation === generation;
  }
}

function positiveRouterLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum
  ) {
    throw new Error(`${label} must be a positive safe integer at most ${String(maximum)}`);
  }
  return resolved;
}

function runtimeTurnKey(threadId: string, turnId: string): string {
  return `${String(threadId.length)}:${threadId}${turnId}`;
}

function expectedThreadArchiveNotificationKey(
  generation: number,
  threadId: string,
): string {
  return `${String(generation)}:${archiveRestartThreadDigest(threadId)}`;
}

function archiveRecoveryRuntimeGeneration(
  descriptor: ArchiveAdmissionDescriptor,
): number {
  return descriptor.successorGeneration ?? descriptor.expectedGeneration;
}

function runtimeObservation(
  process: AccountRuntimeProcess,
): AccountRuntimeObservation {
  return Object.freeze({ generation: process.generation, status: "running" });
}

function retainCompletedTurn(completed: Set<string>, turnKey: string): void {
  retainBoundedIdentity(
    completed,
    turnKey,
    maximumCompletedTurnTombstones,
  );
}

function retainBoundedIdentity(
  values: Set<string>,
  value: string,
  maximum: number,
): void {
  values.delete(value);
  values.add(value);
  while (values.size > maximum) {
    const oldest = values.values().next().value;
    if (oldest === undefined) throw new Error("Bounded runtime identity set underflowed");
    values.delete(oldest);
  }
}
