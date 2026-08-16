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
  readonly callbacks?: AccountRuntimeCallbacks;
  readonly createProcess?: AccountRuntimeProcessFactory;
  readonly dynamicToolCapability?: AccountRuntimeDynamicToolCapabilityResolver;
  readonly maximumLiveProcesses?: number;
  readonly now?: () => number;
  readonly policy?: CodexRestartPolicy;
  readonly restartBudgetResetMs?: number;
  readonly sleep?: (delayMs: number) => Promise<void>;
}

export interface AccountRuntimeEnsureOptions {
  readonly beforeCreate: (generation: number) => void | Promise<void>;
  readonly initialGeneration: number;
}

interface AccountRoute {
  activeOperations: number;
  readonly activeTurns: Set<string>;
  readonly accountProfileId: AccountProfileId;
  readonly completedLoginIds: Set<string>;
  readonly completedTurns: Set<string>;
  admission: Promise<void> | null;
  readonly paths: RuntimePaths;
  readonly pendingServerRequests: Set<CodexRespondableServerRequest>;
  pendingLoginId: string | null;
  lastUsed: number;
  slotHeld: boolean;
  stateCause: AccountRuntimeStateCause;
  stop: Promise<void> | null;
  stopping: boolean;
  readonly supervisor: CodexRestartSupervisor<AccountRuntimeProcess>;
  dynamicToolCapability: PinnedCodexDynamicToolProtocolCapability | null;
}

interface RuntimeAdmissionWaiter {
  readonly deadline: number;
  readonly reject: (error: AccountRuntimeCapacityError) => void;
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

export class AccountRuntimeCapacityError extends Error {
  constructor() {
    super("The account runtime is waiting for local process capacity.");
    this.name = "AccountRuntimeCapacityError";
  }
}

export class AccountRuntimeRouter {
  readonly #admissionTimeoutMs: number;
  readonly #admissionQueue: RuntimeAdmissionWaiter[] = [];
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
    Readonly<{ accountProfileId: AccountProfileId; generation: number }>
  >();
  readonly #sleep: ((delayMs: number) => Promise<void>) | undefined;
  #admissionProcessing = false;
  #capacityGeneration = 0;
  #capacityWait: Readonly<{
    promise: Promise<number>;
    resolve: (generation: number) => void;
  }> | null = null;
  #closed = false;
  #routeClock = 0;

  constructor(options: AccountRuntimeRouterOptions = {}) {
    this.#admissionTimeoutMs = positiveRouterLimit(
      options.admissionTimeoutMs,
      defaultAdmissionTimeoutMs,
      10 * 60_000,
      "Account runtime admission timeout",
    );
    this.#callbacks = options.callbacks ?? {};
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
  }

  async ensure(
    accountProfileId: AccountProfileId,
    paths: RuntimePaths,
    options: AccountRuntimeEnsureOptions,
  ): Promise<AccountRuntimeProcess> {
    const profileId = accountProfileIdSchema.parse(accountProfileId);
    validateGenerationFloor(options.initialGeneration);
    let route = this.#routes.get(profileId);
    if (route !== undefined) {
      const existingRoute = route;
      if (!samePaths(route.paths, paths)) throw new AccountRuntimePathMismatchError();
      if (options.initialGeneration > route.supervisor.generation) {
        throw new AccountRuntimeGenerationFloorMismatchError();
      }
      return await this.#withRouteActivity(existingRoute, async () =>
        await this.#startRoute(existingRoute)
      );
    }

    const routeReference: { current: AccountRoute | null } = { current: null };
    const supervisor = new CodexRestartSupervisor<AccountRuntimeProcess>({
      beforeCreate: options.beforeCreate,
      create: async (generation) => {
        if (routeReference.current === null) {
          throw new Error("Account runtime route was not initialized");
        }
        return await this.#startProcess(routeReference.current, generation);
      },
      initialGeneration: options.initialGeneration,
      onState: (state) => {
        if (routeReference.current !== null) {
          this.#handleSupervisorState(routeReference.current, state);
        }
        this.#callbacks.onState?.(profileId, state, routeReference.current?.stateCause ??
          "provider_lifecycle");
      },
      policy: this.#policy,
      ...(this.#restartBudgetResetMs === undefined
        ? {}
        : { restartBudgetResetMs: this.#restartBudgetResetMs }),
      ...(this.#sleep === undefined ? {} : { sleep: this.#sleep }),
    });
    route = {
      activeOperations: 0,
      activeTurns: new Set(),
      accountProfileId: profileId,
      completedLoginIds: new Set(),
      completedTurns: new Set(),
      admission: null,
      paths,
      pendingServerRequests: new Set(),
      pendingLoginId: null,
      lastUsed: ++this.#routeClock,
      slotHeld: false,
      stateCause: "provider_lifecycle",
      stop: null,
      stopping: false,
      supervisor,
      dynamicToolCapability: null,
    };
    routeReference.current = route;
    this.#routes.set(profileId, route);
    return await this.#withRouteActivity(route, async () =>
      await this.#startRoute(route)
    );
  }

  async request<K extends AccountRuntimeRequestKey>(
    accountProfileId: AccountProfileId,
    key: K,
    input: PinnedCodexRequestInput<K>,
    expectedGeneration?: number,
  ): Promise<PinnedCodexRequestOutput<K>> {
    const route = this.#routeForRequest(accountProfileId);
    return await this.#withRouteActivity(route, async () => {
      const process = await this.#processForRequest(route, expectedGeneration);
      const output = await process.protocol.request(key, input);
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
    const route = this.#routeForRequest(accountProfileId);
    return await this.#withRouteActivity(route, async () => {
      const process = await this.#processForRequest(route, expectedGeneration);
      const positioned = await process.protocol.requestWithResponsePosition(key, input);
      this.#observeRequestOutput(route, key, input, positioned.output);
      return positioned;
    });
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
    if (expectedGeneration !== undefined) {
      validateGenerationFloor(expectedGeneration);
      if (route.supervisor.generation !== expectedGeneration) {
        throw new AccountRuntimeStaleRequestError();
      }
    }
    const process = await this.#startRoute(route);
    if (expectedGeneration !== undefined && process.generation !== expectedGeneration) {
      throw new AccountRuntimeStaleRequestError();
    }
    return process;
  }

  async restart(
    accountProfileId: AccountProfileId,
  ): Promise<AccountRuntimeProcess | null> {
    const route = this.#routeForRequest(accountProfileId);
    return await this.#withRouteActivity(route, async () => {
      await this.#reserveRuntimeSlot(route);
      return await route.supervisor.restart("restart_requested");
    });
  }

  async respond(
    accountProfileId: AccountProfileId,
    request: CodexRespondableServerRequest,
    response: CodexServerResponse,
  ): Promise<CodexStreamPosition | void> {
    const route = this.#routeForRequest(accountProfileId);
    return await this.#withRouteActivity(route, async () => {
      const owner = this.#serverRequestOwners.get(request);
      const process = route.supervisor.current;
      if (
        owner === undefined ||
        owner.accountProfileId !== route.accountProfileId ||
        owner.generation !== request.generation ||
        request.generation !== route.supervisor.generation ||
        process === null ||
        process.generation !== request.generation
      ) {
        throw new AccountRuntimeStaleRequestError();
      }
      this.#serverRequestOwners.delete(request);
      try {
        return await process.protocol.respond(request, response);
      } finally {
        route.pendingServerRequests.delete(request);
        this.#touchRoute(route);
      }
    });
  }

  async stop(accountProfileId: AccountProfileId): Promise<void> {
    const profileId = accountProfileIdSchema.parse(accountProfileId);
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
      !this.supportsDynamicTool(profileId.data, expectedGeneration)
    ) return null;
    const capability = this.#routes.get(profileId.data)?.dynamicToolCapability ?? null;
    return capability?.caller.accountGeneration === expectedGeneration
      ? capability
      : null;
  }

  async #startRoute(route: AccountRoute): Promise<AccountRuntimeProcess> {
    await this.#reserveRuntimeSlot(route);
    try {
      const process = await route.supervisor.start();
      if (!route.slotHeld || route.stopping || this.#closed) {
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
    }
  }

  async #withRouteActivity<T>(
    route: AccountRoute,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.#closed || route.stopping) throw new AccountRuntimeCapacityError();
    route.activeOperations += 1;
    this.#touchRoute(route);
    let outcome:
      | { readonly status: "fulfilled"; readonly value: T }
      | { readonly reason: unknown; readonly status: "rejected" };
    try {
      outcome = { status: "fulfilled", value: await operation() };
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

  async #reserveRuntimeSlot(route: AccountRoute): Promise<void> {
    if (route.slotHeld) return;
    if (this.#closed || route.stopping) throw new AccountRuntimeCapacityError();
    if (route.admission !== null) return await route.admission;
    const admission = new Promise<void>((resolve, reject) => {
      const waiter: RuntimeAdmissionWaiter = {
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
    route.admission = admission;
    try {
      await admission;
    } finally {
      if (route.admission === admission) route.admission = null;
    }
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

  #rejectAdmission(waiter: RuntimeAdmissionWaiter): void {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.timer !== null) clearTimeout(waiter.timer);
    waiter.reject(new AccountRuntimeCapacityError());
  }

  #cancelRouteAdmission(route: AccountRoute): void {
    for (const waiter of this.#admissionQueue) {
      if (waiter.route === route) this.#rejectAdmission(waiter);
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
        route.activeOperations !== 0 || route.activeTurns.size !== 0 ||
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
    route.pendingLoginId = null;
    for (const request of route.pendingServerRequests) {
      this.#serverRequestOwners.delete(request);
    }
    route.pendingServerRequests.clear();
    this.#touchRoute(route);
  }

  #touchRoute(route: AccountRoute): void {
    route.lastUsed = ++this.#routeClock;
    if (
      route.activeOperations === 0 && route.activeTurns.size === 0 &&
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

  async #startProcess(
    route: AccountRoute,
    generation: number,
  ): Promise<AccountRuntimeProcess> {
    if (!route.slotHeld || route.stopping || this.#closed) {
      throw new AccountRuntimeCapacityError();
    }
    const dynamicToolCapability = await this.#resolveDynamicToolCapability(
      route,
      generation,
    );
    const process = await this.#createProcess({
      accountProfileId: route.accountProfileId,
      callbacks: this.#scopedCallbacks(route),
      dynamicToolCapability,
      generation,
      paths: route.paths,
    });
    route.dynamicToolCapability = dynamicToolCapability;
    void process.faulted.then((reason) => {
      if (
        this.#closed || route.stopping || !route.slotHeld ||
        route.supervisor.current !== process ||
        !this.#isCurrentGeneration(route.accountProfileId, generation)
      ) return;
      void route.supervisor.restart(reason, generation);
    });
    return process;
  }

  #scopedCallbacks(route: AccountRoute): CodexRpcCallbacks {
    const accountProfileId = route.accountProfileId;
    const onDynamicToolRequest = this.#callbacks.onDynamicToolRequest;
    return {
      onNotification: async (notification) => {
        if (!this.#isCurrentGeneration(accountProfileId, notification.generation)) return;
        this.#touchRoute(route);
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
          await this.#callbacks.onNotification?.(accountProfileId, notification);
        } finally {
          if (notification.method === "turn/completed" && turnKey !== null) {
            route.activeTurns.delete(turnKey);
            this.#touchRoute(route);
          }
        }
      },
      onServerRequest: async (request) => {
        if (!this.#isCurrentGeneration(accountProfileId, request.generation)) return;
        this.#serverRequestOwners.set(request, {
          accountProfileId,
          generation: request.generation,
        });
        route.pendingServerRequests.add(request);
        this.#touchRoute(route);
        await this.#callbacks.onServerRequest?.(accountProfileId, request);
      },
      ...(onDynamicToolRequest === undefined
        ? {}
        : {
          onDynamicToolRequest: async (request: PinnedCodexDynamicToolRequest) => {
            if (!this.#isCurrentGeneration(accountProfileId, request.generation)) return;
            this.#serverRequestOwners.set(request, {
              accountProfileId,
              generation: request.generation,
            });
            route.pendingServerRequests.add(request);
            this.#touchRoute(route);
            await onDynamicToolRequest(accountProfileId, request);
          },
        }),
      onDiagnostic: async (diagnostic) => {
        if (!this.#isCurrentGeneration(accountProfileId, diagnostic.generation)) return;
        this.#touchRoute(route);
        await this.#callbacks.onDiagnostic?.(accountProfileId, diagnostic);
      },
      onServerRequestExpired: async (fault) => {
        if (!this.#isCurrentGeneration(accountProfileId, fault.generation)) return;
        this.#removeExpiredServerRequest(route, fault);
        this.#touchRoute(route);
        await this.#callbacks.onServerRequestExpired?.(accountProfileId, fault);
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
