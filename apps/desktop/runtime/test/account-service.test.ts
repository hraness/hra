import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AccountSummary,
  RuntimeEvent,
} from "../../contracts/runtime";
import {
  AccountService,
  type AccountRuntimeRouterPort,
  type AccountUsageProjectionScheduler,
  type ExternalUrlOpener,
} from "../src/accounts/account-service";
import { dispatchBudgetFreshnessMs } from "../src/accounts/dispatch-budget";
import { rankChatAccountCandidates } from "../src/chat/chat-service";
import type { AccountProfileFileSystem } from "../src/accounts/local-data-remover";
import { accountProfileLayout } from "../src/accounts/profile-layout";
import { AccountProfileStore } from "../src/accounts/profile-store";
import {
  AccountRuntimeRouter,
  type AccountRuntimeFaultReason,
  type AccountRuntimeProcess,
  type AccountRuntimeProcessFactoryInput,
  type AccountRuntimeRequestKey,
} from "../src/accounts/runtime-router";
import {
  type CodexGenerationEndReason,
  CodexRemoteResponseError,
  type CodexNotification,
  type PinnedCodexRequestInput,
  type PinnedCodexRequestOutput,
  type CodexRpcCallbacks,
} from "../src/codex";
import { projectCodexNotificationFacts } from "../src/codex/fact-projector";
import type { RuntimePaths } from "../src/runtime-paths";
import { applyMigrations } from "../src/state/database";
import { OperationReceiptStore } from "../src/state/operation-receipts";

const temporaryDirectories: string[] = [];

function consumeNotification(
  service: AccountService,
  accountProfileId: string,
  notification: CodexNotification,
): void {
  service.consumeCodexFacts(
    projectCodexNotificationFacts(accountProfileId, notification),
  );
}

async function rejection(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error: unknown) {
    if (error instanceof Error) return error;
    throw new Error("Expected a rejected Error");
  }
  throw new Error("Expected the operation to reject");
}

async function withinDeadline<T>(operation: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("operation exceeded fixture deadline")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

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

class FakeOpener implements ExternalUrlOpener {
  readonly opened: string[] = [];

  open(url: string): Promise<void> {
    this.opened.push(url);
    return Promise.resolve();
  }
}

class FakeUsageProjectionScheduler implements AccountUsageProjectionScheduler {
  readonly tasks: Array<{
    active: boolean;
    callback: () => void;
    delayMs: number;
  }> = [];

  schedule(callback: () => void, delayMs: number): () => void {
    const task = { active: true, callback, delayMs };
    this.tasks.push(task);
    return () => {
      task.active = false;
    };
  }

  runNext(): number {
    const task = this.tasks.find(({ active }) => active);
    if (task === undefined) throw new Error("no active usage projection timer");
    task.active = false;
    task.callback();
    return task.delayMs;
  }
}

class FakeAccountProfileFileSystem implements AccountProfileFileSystem {
  readonly calls: Array<Readonly<{
    action: "delete" | "ensure";
    accountProfileId: string;
    expectedRevision?: number;
  }>> = [];
  failure: Error | null = null;
  operation: (
    accountProfileId: string,
    expectedRevision: number,
  ) => Promise<void> = async (accountProfileId) => {
    const layout = accountProfileLayout(
      this.controlPlanePath,
      accountProfileId,
    );
    await rm(layout.codexHome, { recursive: true, force: true });
  };

  readonly controlPlanePath: string;

  constructor(controlPlanePath: string) {
    this.controlPlanePath = controlPlanePath;
  }

  async ensureAccountProfile(accountProfileId: string): Promise<void> {
    this.calls.push({ action: "ensure", accountProfileId });
    if (this.failure !== null) throw this.failure;
    const layout = accountProfileLayout(
      this.controlPlanePath,
      accountProfileId,
    );
    for (const path of [
      layout.stateRoot,
      join(layout.stateRoot, "codex"),
      layout.accountsRoot,
      layout.profileRoot,
      layout.codexHome,
      layout.runtimeDirectory,
    ]) {
      try {
        const metadata = await lstat(path);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
          throw new Error("unsafe fake profile path");
        }
      } catch (error: unknown) {
        if (!hasCode(error, "ENOENT")) throw error;
        await mkdir(path, { mode: 0o700 });
      }
      await chmod(path, 0o700);
    }
  }

  async deleteAccountHome(
    accountProfileId: string,
    expectedRevision: number,
  ): Promise<void> {
    this.calls.push({
      action: "delete",
      accountProfileId,
      expectedRevision,
    });
    if (this.failure !== null) throw this.failure;
    await this.operation(accountProfileId, expectedRevision);
  }
}

interface FakePinnedRequest {
  readonly accountProfileId: string;
  readonly expectedGeneration: number | undefined;
  readonly input: unknown;
  readonly key: AccountRuntimeRequestKey;
}

class FakeRouter implements AccountRuntimeRouterPort {
  afterPositionedResponse: ((request: FakePinnedRequest) => void | Promise<void>) | null = null;
  beforeFence: ((accountProfileId: string, expectedGeneration: number) =>
    void | Promise<void>) | null = null;
  beforeRequest: ((request: FakePinnedRequest) => void | Promise<void>) | null = null;
  cancelStatus: "canceled" | "notFound" = "canceled";
  readonly failures = new Map<AccountRuntimeRequestKey, Error>();
  readonly fenceCalls: Array<Readonly<{
    accountProfileId: string;
    expectedGeneration: number;
  }>> = [];
  fenceFailure: Error | null = null;
  onStopAll: (() => void | Promise<void>) | null = null;
  readonly paths = new Map<string, RuntimePaths>();
  readonly requests: FakePinnedRequest[] = [];
  readonly restartCalls: string[] = [];
  restartFailure: Error | null = null;
  readonly running = new Set<string>();
  readonly signedOutAccounts = new Set<string>();
  readonly stopCalls: string[] = [];
  stopFailure: Error | null = null;
  readonly generations = new Map<string, number>();
  readonly generationGates = new Map<
    string,
    (generation: number) => void | Promise<void>
  >();

  async ensure(
    accountProfileId: string,
    paths: RuntimePaths,
    options: {
      readonly initialGeneration: number;
      readonly beforeCreate: (generation: number) => void | Promise<void>;
    },
  ): Promise<unknown> {
    this.paths.set(accountProfileId, paths);
    this.generationGates.set(accountProfileId, options.beforeCreate);
    if (this.running.has(accountProfileId)) return {};
    const generation = (this.generations.get(accountProfileId) ?? options.initialGeneration) + 1;
    await options.beforeCreate(generation);
    this.running.add(accountProfileId);
    this.generations.set(accountProfileId, generation);
    return {};
  }

  async request<K extends AccountRuntimeRequestKey>(
    accountProfileId: string,
    key: K,
    input: PinnedCodexRequestInput<K>,
    expectedGeneration?: number,
  ): Promise<PinnedCodexRequestOutput<K>> {
    const request = { accountProfileId, expectedGeneration, input, key };
    this.requests.push(request);
    await this.beforeRequest?.(request);
    const failure = this.failures.get(key);
    if (failure !== undefined) return Promise.reject(failure);
    const suffix = accountProfileId.slice(-4);
    switch (key) {
      case "accountRead":
        if (this.signedOutAccounts.has(accountProfileId)) {
          return Promise.resolve(fakePinnedOutput<K>({
            account: null,
            requiresOpenaiAuth: true,
          }));
        }
        return Promise.resolve(fakePinnedOutput<K>({
          account: {
            type: "chatgpt",
            email: `${suffix}@example.test`,
            planType: suffix.endsWith("1") ? "plus" : "pro",
          },
          requiresOpenaiAuth: true,
        }));
      case "accountRateLimitsRead":
        return Promise.resolve(fakePinnedOutput<K>({
          rateLimits: rateLimit(`${suffix}-default`, 5),
          rateLimitsByLimitId: {
            [`limit-${suffix}`]: rateLimit(`limit-${suffix}`, suffix.endsWith("1") ? 10 : 20),
          },
          rateLimitResetCredits: null,
        }));
      case "accountUsageRead":
        return Promise.resolve(fakePinnedOutput<K>({
          summary: {
            lifetimeTokens: suffix.endsWith("1") ? "101" : "202",
            peakDailyTokens: "50",
            longestRunningTurnSec: "42",
            currentStreakDays: "3",
            longestStreakDays: "7",
          },
          dailyUsageBuckets: [{ startDate: "2026-07-19", tokens: "12" }],
        }));
      case "accountLoginStart":
        if (
          typeof input === "object" &&
          input !== null &&
          "type" in input &&
          input.type === "chatgptDeviceCode"
        ) {
          return Promise.resolve(fakePinnedOutput<K>({
            type: "chatgptDeviceCode",
            loginId: `login-${suffix}`,
            verificationUrl: `https://auth.openai.com/device/${suffix}?private=opaque`,
            userCode: `DEVICE-${suffix}`,
          }));
        }
        return Promise.resolve(fakePinnedOutput<K>({
          type: "chatgpt",
          loginId: `login-${suffix}`,
          authUrl: `https://auth.openai.com/${suffix}?private=opaque`,
        }));
      case "accountLoginCancel":
        return Promise.resolve(fakePinnedOutput<K>({ status: this.cancelStatus }));
      case "accountLogout":
        if (this.signedOutAccounts.has(accountProfileId)) {
          return Promise.reject(new Error("the fake provider is already signed out"));
        }
        this.signedOutAccounts.add(accountProfileId);
        return Promise.resolve(fakePinnedOutput<K>(undefined));
      case "threadList":
        return Promise.resolve(fakePinnedOutput<K>({
          data: [],
          nextCursor: null,
          backwardsCursor: null,
        }));
      case "threadStart":
      case "threadResume":
      case "threadRead":
      case "threadHistoryRead":
      case "threadTurnsList":
      case "threadItemsList":
      case "threadFork":
      case "threadGoalSet":
      case "threadGoalGet":
      case "threadGoalClear":
      case "threadSetName":
      case "threadInjectItems":
      case "modelList":
      case "turnStart":
      case "turnSteer":
      case "turnInterrupt":
        throw new Error("the account-service fixture does not serve this session request");
      default:
        throw new Error(`the account-service fixture does not serve ${String(key)}`);
    }
  }

  async requestWithResponsePosition<K extends AccountRuntimeRequestKey>(
    accountProfileId: string,
    key: K,
    input: PinnedCodexRequestInput<K>,
    expectedGeneration?: number,
  ) {
    const response = {
      generation: this.generation(accountProfileId) ?? 1,
      output: await this.request(accountProfileId, key, input, expectedGeneration),
      streamPosition: 1,
    };
    await this.afterPositionedResponse?.({ accountProfileId, expectedGeneration, input, key });
    return response;
  }

  async restart(accountProfileId: string): Promise<object | null> {
    this.restartCalls.push(accountProfileId);
    if (this.restartFailure !== null) throw this.restartFailure;
    const gate = this.generationGates.get(accountProfileId);
    if (gate === undefined) throw new Error("fake runtime generation gate missing");
    const generation = (this.generations.get(accountProfileId) ?? 0) + 1;
    await gate(generation);
    this.running.add(accountProfileId);
    this.generations.set(accountProfileId, generation);
    return {};
  }

  async fenceGeneration(
    accountProfileId: string,
    expectedGeneration: number,
  ): Promise<"already_fenced" | "fenced"> {
    this.fenceCalls.push({ accountProfileId, expectedGeneration });
    await this.beforeFence?.(accountProfileId, expectedGeneration);
    if (this.fenceFailure !== null) throw this.fenceFailure;
    if (
      this.generations.get(accountProfileId) !== expectedGeneration ||
      !this.running.has(accountProfileId)
    ) return "already_fenced";
    this.running.delete(accountProfileId);
    return "fenced";
  }

  stop(accountProfileId: string): Promise<void> {
    this.stopCalls.push(accountProfileId);
    if (this.stopFailure !== null) return Promise.reject(this.stopFailure);
    this.running.delete(accountProfileId);
    return Promise.resolve();
  }

  async stopAll(): Promise<void> {
    this.running.clear();
    await this.onStopAll?.();
  }

  isRunning(accountProfileId: string): boolean {
    return this.running.has(accountProfileId);
  }

  generation(accountProfileId: string): number | null {
    return this.generations.get(accountProfileId) ?? null;
  }
}

class FakeGenerationProcess implements AccountRuntimeProcess {
  readonly callbacks: CodexRpcCallbacks;
  readonly protocol: AccountRuntimeProcess['protocol'] = {
    request: () => Promise.reject(new Error("generation fixture does not serve account requests")),
    requestWithResponsePosition: () => Promise.reject(
      new Error("generation fixture does not serve account requests"),
    ),
    respond: () => Promise.resolve(),
  };
  readonly expired: CodexGenerationEndReason[] = [];
  readonly faulted: Promise<AccountRuntimeFaultReason> = new Promise(() => undefined);
  readonly generation: number;

  constructor(input: AccountRuntimeProcessFactoryInput) {
    this.callbacks = input.callbacks;
    this.generation = input.generation;
  }

  expire(reason: CodexGenerationEndReason): void {
    this.expired.push(reason);
  }
}

function fakePinnedOutput<K extends AccountRuntimeRequestKey>(
  value: unknown,
): PinnedCodexRequestOutput<K> {
  return value as PinnedCodexRequestOutput<K>;
}

function rateLimit(id: string, usedPercent: number) {
  return {
    limitId: id,
    limitName: id,
    primary: { usedPercent, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    secondary: null,
    credits: null,
    individualLimit: null,
    planType: "pro",
    rateLimitReachedType: null,
  } as const;
}

async function fixture(
  options: Readonly<{
    now?: () => Date;
    routingRefreshTimeoutMs?: number;
    usageProjectionScheduler?: AccountUsageProjectionScheduler;
  }> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "oprte-account-service-"));
  temporaryDirectories.push(root);
  const controlPlanePath = join(root, "state", "control-plane.sqlite");
  await mkdir(join(root, "state"), { recursive: true });
  const database = new Database(controlPlanePath, { create: true, strict: true });
  applyMigrations(database);
  const ids = ["acct_isolated_0001", "acct_isolated_0002"];
  const store = new AccountProfileStore(database, {
    idFactory: () => {
      const id = ids.shift();
      if (id === undefined) throw new Error("fake IDs exhausted");
      return id;
    },
  });
  const router = new FakeRouter();
  const opener = new FakeOpener();
  const localDataRemover =
    new FakeAccountProfileFileSystem(controlPlanePath);
  const events: AccountEvent[] = [];
  let clock = 0;
  const createService = () => new AccountService({
    assets: {
      codexBinary: "/fixture/codex",
      gitBinary: "/fixture/git/bin/git",
      gitRoot: "/fixture/git",
    },
    controlPlanePath,
    emit: (event) => events.push(structuredClone(event)),
    externalUrlOpener: opener,
    profileFileSystem: localDataRemover,
    now: options.now ?? (() => new Date(Date.UTC(2026, 6, 19, 12, 0, clock++))),
    ...(options.routingRefreshTimeoutMs === undefined
      ? {}
      : { routingRefreshTimeoutMs: options.routingRefreshTimeoutMs }),
    router,
    store,
    ...(options.usageProjectionScheduler === undefined
      ? {}
      : { usageProjectionScheduler: options.usageProjectionScheduler }),
  });
  const service = createService();
  return {
    controlPlanePath,
    createService,
    database,
    events,
    localDataRemover,
    opener,
    router,
    service,
    store,
  };
}

async function generationRecoveryFixture() {
  const root = await mkdtemp(join(tmpdir(), "oprte-generation-recovery-"));
  temporaryDirectories.push(root);
  const controlPlanePath = join(root, "state", "control-plane.sqlite");
  await mkdir(join(root, "state"), { recursive: true });
  const database = new Database(controlPlanePath, { create: true, strict: true });
  applyMigrations(database);
  const store = new AccountProfileStore(database, {
    idFactory: () => "acct_generation_0001",
  });
  const callbackOwners = new Map<number, CodexRpcCallbacks>();
  const processes: FakeGenerationProcess[] = [];
  const events: AccountEvent[] = [];
  let service: AccountService | null = null;
  const router = new AccountRuntimeRouter({
    callbacks: {
      onNotification: (accountProfileId, notification) => {
        if (service !== null) consumeNotification(service, accountProfileId, notification);
      },
      onState: (accountProfileId, state) => {
        service?.handleRuntimeState(accountProfileId, state);
      },
    },
    createProcess: (input) => {
      callbackOwners.set(input.generation, input.callbacks);
      const process = new FakeGenerationProcess(input);
      processes.push(process);
      return Promise.resolve(process);
    },
    policy: {
      initialDelayMs: 1,
      maximumDelayMs: 1,
      maximumRestartAttempts: 2,
    },
    sleep: () => Promise.resolve(),
  });
  let clock = 0;
  service = new AccountService({
    assets: {
      codexBinary: "/fixture/codex",
      gitBinary: "/fixture/git/bin/git",
      gitRoot: "/fixture/git",
    },
    controlPlanePath,
    emit: (event) => events.push(structuredClone(event)),
    profileFileSystem: new FakeAccountProfileFileSystem(controlPlanePath),
    now: () => new Date(Date.UTC(2026, 6, 29, 12, 0, clock++)),
    router,
    store,
  });
  return { callbackOwners, database, events, processes, router, service, store };
}

function accountResult(result: Awaited<ReturnType<AccountService['execute']>>): AccountSummary {
  if (result.type !== "account") throw new Error("expected an account result");
  return result.account;
}

describe("AccountService", () => {
  test("a failed profile creation remains recoverable without exceeding snapshot capacity", async () => {
    const { database, events, localDataRemover, service, store } = await fixture();
    try {
      localDataRemover.failure = new Error("injected private filesystem failure");
      expect(rejection(
        service.execute({ type: "account.create", label: "Unprepared" }),
      )).resolves.toBe(localDataRemover.failure);

      expect(store.list()).toEqual([]);
      expect(store.listRetainedLocalData()).toEqual([
        expect.objectContaining({
          id: "acct_isolated_0001",
          label: "Unprepared",
          localDataState: "present",
        }),
      ]);
      expect(events.map((event) => event.type)).toEqual([
        "accountLocalData.upserted",
      ]);
      const event = events[0];
      if (event?.type !== "accountLocalData.upserted") {
        throw new Error("expected retained local-data projection");
      }
      expect(event.localData.id).toBe("acct_isolated_0001");
      expect(event.localData.label).toBe("Unprepared");
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("ambiguous chat containment fences exactly once and recovers lazily", async () => {
    const { database, router, service, store } = await fixture();
    try {
      const created = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      store.updateAuthState(created.id, "signedIn", new Date("2026-07-19T12:00:00.000Z"));
      await service.refreshDispatchAccounts();
      const initialGeneration = router.generation(created.id);
      if (initialGeneration === null) throw new Error("fake runtime generation missing");

      await service.containAmbiguousChatEffect(created.id);
      expect(router.fenceCalls).toEqual([{
        accountProfileId: created.id,
        expectedGeneration: initialGeneration,
      }]);
      expect(router.restartCalls).toEqual([]);
      expect(router.generation(created.id)).toBe(initialGeneration);
      expect(router.isRunning(created.id)).toBeFalse();

      await service.requestSession(created.id, "threadList", {
        cursor: null,
        limit: 64,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["appServer"],
        archived: false,
      });
      expect(router.generation(created.id)).toBe(initialGeneration + 1);
      expect(store.find(created.id)?.processGeneration).toBe(initialGeneration + 1);
      expect(router.isRunning(created.id)).toBeTrue();
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("queued logout prevents ambiguous chat containment from restarting the account", async () => {
    const { database, router, service, store } = await fixture();
    try {
      const created = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      store.updateAuthState(created.id, "signedIn", new Date("2026-07-19T12:00:00.000Z"));
      await service.refreshDispatchAccounts();

      const logout = service.execute({ type: "account.logout", accountProfileId: created.id });
      const containment = service.containAmbiguousChatEffect(created.id);
      await Promise.all([logout, containment]);

      expect(store.find(created.id)).toBeNull();
      expect(store.listRetainedLocalData()).toEqual([
        expect.objectContaining({ id: created.id, localDataState: "present" }),
      ]);
      expect(router.fenceCalls).toHaveLength(1);
      expect(router.restartCalls).toEqual([]);
      expect(router.isRunning(created.id)).toBeFalse();
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("durably resumes a provider-acknowledged logout and removes the row after restart", async () => {
    const {
      createService,
      database,
      events,
      router,
      service,
      store,
    } = await fixture();
    let resumedService: AccountService | null = null;
    try {
      const created = accountResult(
        await service.execute({ type: "account.create", label: "Work" }),
      );
      store.updateAuthState(created.id, "signedIn", new Date("2026-07-19T12:00:00.000Z"));
      router.stopFailure = new Error("fixture crash after provider logout acknowledgement");

      expect(await rejection(service.execute({
        type: "account.logout",
        accountProfileId: created.id,
      }))).toBeInstanceOf(Error);
      expect(router.signedOutAccounts.has(created.id)).toBeTrue();
      expect(store.find(created.id)?.authState).toBe("signingOut");

      const generation = router.generation(created.id);
      if (generation === null) throw new Error("fake runtime generation missing");
      consumeNotification(service, created.id, {
        generation,
        streamPosition: 1,
        method: "account/updated",
        params: { authMode: null, planType: null },
      });
      expect(store.find(created.id)?.authState).toBe("signingOut");
      expect(await rejection(service.execute({
        type: "account.refresh",
        accountProfileId: created.id,
      }))).toMatchObject({ code: "conflict" });
      expect(await rejection(service.execute({
        type: "account.login.start",
        accountProfileId: created.id,
        mode: "browser",
      }))).toMatchObject({ code: "conflict" });
      expect(store.find(created.id)?.authState).toBe("signingOut");

      await service.shutdown();
      router.stopFailure = null;
      resumedService = createService();
      expect((await resumedService.initialize())[0]).toMatchObject({
        id: created.id,
        authState: "signingOut",
      });
      for (let attempts = 0; attempts < 200 && store.find(created.id) !== null; attempts += 1) {
        await Bun.sleep(1);
      }
      expect(store.find(created.id)).toBeNull();
      expect(store.listRetainedLocalData()).toEqual([
        expect.objectContaining({ id: created.id, localDataState: "present" }),
      ]);
      expect(router.requests.filter(({ key }) => key === "accountLogout")).toHaveLength(1);
      expect(events.findLast((event) => event.type === "account.removed")).toEqual({
        type: "account.removed",
        accountProfileId: created.id,
      });
    } finally {
      await resumedService?.shutdown();
      await service.shutdown();
      database.close();
    }
  });

  test("queued removal prevents ambiguous chat containment from restarting the account", async () => {
    const { database, router, service, store } = await fixture();
    try {
      const created = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      store.updateAuthState(created.id, "signedIn", new Date("2026-07-19T12:00:00.000Z"));
      await service.refreshDispatchAccounts();
      const revision = store.find(created.id)?.revision;
      if (revision === undefined) throw new Error("fixture account disappeared");

      const removal = service.execute({
        type: "account.remove",
        accountProfileId: created.id,
        expectedRevision: revision,
      });
      const containment = service.containAmbiguousChatEffect(created.id);
      await Promise.all([removal, containment]);

      expect(store.find(created.id)).toBeNull();
      expect(router.fenceCalls).toHaveLength(1);
      expect(router.restartCalls).toEqual([]);
      expect(router.isRunning(created.id)).toBeFalse();
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("ambiguous containment never stops a newer generation", async () => {
    const { database, router, service, store } = await fixture();
    try {
      const created = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      store.updateAuthState(created.id, "signedIn", new Date("2026-07-19T12:00:00.000Z"));
      await service.refreshDispatchAccounts();
      const initialGeneration = router.generation(created.id);
      if (initialGeneration === null) throw new Error("fake runtime generation missing");

      router.beforeFence = (accountProfileId, expectedGeneration) => {
        expect(accountProfileId).toBe(created.id);
        expect(expectedGeneration).toBe(initialGeneration);
        router.generations.set(created.id, initialGeneration + 1);
        router.running.add(created.id);
      };
      await service.containAmbiguousChatEffect(created.id);

      expect(router.fenceCalls).toEqual([{
        accountProfileId: created.id,
        expectedGeneration: initialGeneration,
      }]);
      expect(router.generation(created.id)).toBe(initialGeneration + 1);
      expect(router.isRunning(created.id)).toBeTrue();
      expect(router.stopCalls).toEqual([]);
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("ambiguous containment preempts a hung request and quarantines later pane admission", async () => {
    const { database, router, service, store } = await fixture();
    let releaseFirst: () => void = () => undefined;
    try {
      const created = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      store.updateAuthState(created.id, "signedIn", new Date("2026-07-19T12:00:00.000Z"));
      await service.refreshDispatchAccounts();
      const initialGeneration = router.generation(created.id);
      if (initialGeneration === null) throw new Error("fake runtime generation missing");

      let announceFirst: () => void = () => undefined;
      const firstEntered = new Promise<void>((resolve) => {
        announceFirst = resolve;
      });
      const firstRelease = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let heldFirst = false;
      router.beforeRequest = async ({ key }) => {
        if (key !== "turnStart" || heldFirst) return;
        heldFirst = true;
        announceFirst();
        await firstRelease;
      };
      const firstInput = {
        threadId: "thread_quarantine_a",
        clientUserMessageId: "message_quarantine_a",
        input: [{ type: "text", text: "Pane A", text_elements: [] }],
      } satisfies PinnedCodexRequestInput<"turnStart">;
      const secondInput = {
        threadId: "thread_quarantine_b",
        clientUserMessageId: "message_quarantine_b",
        input: [{ type: "text", text: "Pane B", text_elements: [] }],
      } satisfies PinnedCodexRequestInput<"turnStart">;

      const first = service.requestSession(created.id, "turnStart", firstInput);
      const firstFailure = rejection(first);
      await firstEntered;
      const containment = service.containAmbiguousChatEffect(created.id);
      const secondFailure = rejection(
        service.requestSession(created.id, "turnStart", secondInput),
      );

      expect(await secondFailure).toMatchObject({
        code: "runtime_unavailable",
        action: "restartRuntime",
      });
      await withinDeadline(containment);
      expect(router.fenceCalls).toEqual([{
        accountProfileId: created.id,
        expectedGeneration: initialGeneration,
      }]);
      expect(router.isRunning(created.id)).toBeFalse();

      releaseFirst();
      expect(await firstFailure).toBeInstanceOf(Error);
      expect(router.requests.filter(({ key }) => key === "turnStart")).toHaveLength(1);

      await service.requestSession(created.id, "threadList", {
        cursor: null,
        limit: 64,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["appServer"],
        archived: false,
      });
      expect(router.generation(created.id)).toBe(initialGeneration + 1);
      expect(router.requests.filter(({ key }) => key === "threadList")).toHaveLength(1);
    } finally {
      releaseFirst();
      await service.shutdown();
      database.close();
    }
  });

  test("duplicate ambiguous containment is one exact-generation fence", async () => {
    const { database, router, service, store } = await fixture();
    let releaseFence: () => void = () => undefined;
    try {
      const created = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      store.updateAuthState(created.id, "signedIn", new Date("2026-07-19T12:00:00.000Z"));
      await service.refreshDispatchAccounts();
      const initialGeneration = router.generation(created.id);
      if (initialGeneration === null) throw new Error("fake runtime generation missing");

      let announceFence: () => void = () => undefined;
      const fenceEntered = new Promise<void>((resolve) => {
        announceFence = resolve;
      });
      const fenceRelease = new Promise<void>((resolve) => {
        releaseFence = resolve;
      });
      router.beforeFence = async () => {
        // Model the production supervisor clearing its current process before
        // the bounded child-exit proof completes.
        router.running.delete(created.id);
        announceFence();
        await fenceRelease;
      };

      const first = service.containAmbiguousChatEffect(created.id);
      const duplicate = service.containAmbiguousChatEffect(created.id);
      expect(duplicate).toBe(first);
      await fenceEntered;
      expect(router.fenceCalls).toEqual([{
        accountProfileId: created.id,
        expectedGeneration: initialGeneration,
      }]);
      const premature = service.requestSession(created.id, "threadList", {
        cursor: null,
        limit: 64,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["appServer"],
        archived: false,
      });
      expect(await rejection(premature)).toMatchObject({
        code: "runtime_unavailable",
        action: "restartRuntime",
      });
      expect(router.requests.filter(({ key }) => key === "threadList")).toHaveLength(0);

      releaseFence();
      await Promise.all([first, duplicate]);
      expect(router.isRunning(created.id)).toBeFalse();
    } finally {
      releaseFence();
      await service.shutdown();
      database.close();
    }
  });

  test("a failed generation fence keeps admission quarantined until a later fence succeeds", async () => {
    const { database, router, service, store } = await fixture();
    try {
      const created = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      store.updateAuthState(created.id, "signedIn", new Date("2026-07-19T12:00:00.000Z"));
      await service.refreshDispatchAccounts();
      const initialGeneration = router.generation(created.id);
      if (initialGeneration === null) throw new Error("fake runtime generation missing");

      router.fenceFailure = new Error("fixture fence failure");
      expect(await rejection(service.containAmbiguousChatEffect(created.id))).toMatchObject({
        message: "fixture fence failure",
      });
      const blocked = service.requestSession(created.id, "threadList", {
        cursor: null,
        limit: 64,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["appServer"],
        archived: false,
      });
      expect(await rejection(blocked)).toMatchObject({
        code: "runtime_unavailable",
        action: "restartRuntime",
      });
      expect(router.requests.filter(({ key }) => key === "threadList")).toHaveLength(0);

      router.fenceFailure = null;
      await service.containAmbiguousChatEffect(created.id);
      expect(router.fenceCalls).toEqual([
        { accountProfileId: created.id, expectedGeneration: initialGeneration },
        { accountProfileId: created.id, expectedGeneration: initialGeneration },
      ]);
      await service.requestSession(created.id, "threadList", {
        cursor: null,
        limit: 64,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["appServer"],
        archived: false,
      });
      expect(router.generation(created.id)).toBe(initialGeneration + 1);
      expect(router.requests.filter(({ key }) => key === "threadList")).toHaveLength(1);
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("shutdown and an in-flight fence never relaunch the account", async () => {
    const { database, router, service, store } = await fixture();
    let releaseFence: () => void = () => undefined;
    try {
      const created = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      store.updateAuthState(created.id, "signedIn", new Date("2026-07-19T12:00:00.000Z"));
      await service.refreshDispatchAccounts();

      let announceFence: () => void = () => undefined;
      const fenceEntered = new Promise<void>((resolve) => {
        announceFence = resolve;
      });
      const fenceRelease = new Promise<void>((resolve) => {
        releaseFence = resolve;
      });
      router.beforeFence = async () => {
        announceFence();
        await fenceRelease;
      };
      const containment = service.containAmbiguousChatEffect(created.id);
      await fenceEntered;
      await service.shutdown();
      expect(router.isRunning(created.id)).toBeFalse();

      releaseFence();
      await containment;
      expect(router.restartCalls).toEqual([]);
      expect(router.isRunning(created.id)).toBeFalse();
    } finally {
      releaseFence();
      await service.shutdown();
      database.close();
    }
  });

  test("shutdown fences app servers before waiting for a hung account tail", async () => {
    const { database, router, service, store } = await fixture();
    let releaseRequest: () => void = () => undefined;
    try {
      const created = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      store.updateAuthState(created.id, "signedIn", new Date("2026-07-19T12:00:00.000Z"));

      let announceRequest: () => void = () => undefined;
      const requestEntered = new Promise<void>((resolve) => {
        announceRequest = resolve;
      });
      const requestRelease = new Promise<void>((resolve) => {
        releaseRequest = resolve;
      });
      router.beforeRequest = async ({ key }) => {
        if (key !== "accountRead") return;
        announceRequest();
        await requestRelease;
        throw new Error("fixture request canceled by runtime shutdown");
      };
      router.onStopAll = () => releaseRequest();

      const refresh = service.refreshDispatchAccounts();
      await requestEntered;
      await withinDeadline(service.shutdown());
      await refresh;

      expect(router.isRunning(created.id)).toBeFalse();
      expect(router.restartCalls).toEqual([]);
    } finally {
      releaseRequest();
      await service.shutdown();
      database.close();
    }
  });

  test("projects only the bounded remaining capacity while retaining routing detail", async () => {
    const { database, router, service, store } = await fixture();
    try {
      const created = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      store.updateAuthState(created.id, "signedIn", new Date("2026-07-19T12:00:00.000Z"));

      const accounts = await service.refreshDispatchAccounts();

      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        id: created.id,
        authState: "signedIn",
        usageRemainingPercent: 90,
        usage: {
          state: "ready",
          limits: [{ id: "limit-0001", primary: { usedPercent: 10 } }],
        },
      });
      expect(router.requests.map(({ key }) => key)).toEqual([
        "accountRead",
        "accountRateLimitsRead",
      ]);
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("routing refresh isolates a stalled account and observes its late completion", async () => {
    const { database, router, service, store } = await fixture({
      routingRefreshTimeoutMs: 10,
    });
    let releaseStalledAccount: () => void = () => undefined;
    try {
      const stalled = accountResult(
        await service.execute({ type: "account.create", label: "Stalled" }),
      );
      const healthy = accountResult(
        await service.execute({ type: "account.create", label: "Healthy" }),
      );
      const signedInAt = new Date("2026-07-19T12:00:00.000Z");
      store.updateAuthState(stalled.id, "signedIn", signedInAt);
      store.updateAuthState(healthy.id, "signedIn", signedInAt);

      let announceStalledAccount: () => void = () => undefined;
      const stalledAccountEntered = new Promise<void>((resolve) => {
        announceStalledAccount = resolve;
      });
      const stalledAccountRelease = new Promise<void>((resolve) => {
        releaseStalledAccount = resolve;
      });
      let stalledOnce = false;
      router.beforeRequest = async ({ accountProfileId, key }) => {
        if (accountProfileId !== stalled.id || key !== "accountRead" || stalledOnce) return;
        stalledOnce = true;
        announceStalledAccount();
        await stalledAccountRelease;
      };

      const firstRefresh = service.refreshChatAccountCandidates();
      await stalledAccountEntered;
      expect(await withinDeadline(firstRefresh, 250)).toEqual([
        {
          id: stalled.id,
          selected: true,
          budget: "unknown",
          remainingPercent: null,
        },
        {
          id: healthy.id,
          selected: false,
          budget: "healthy",
          remainingPercent: 80,
        },
      ]);

      // A second pane reuses the stalled account's cached state instead of
      // queueing another read behind the same unresolved telemetry request.
      expect(await withinDeadline(service.refreshChatAccountCandidates(), 250)).toEqual([
        {
          id: stalled.id,
          selected: true,
          budget: "unknown",
          remainingPercent: null,
        },
        {
          id: healthy.id,
          selected: false,
          budget: "healthy",
          remainingPercent: 80,
        },
      ]);
      expect(router.requests.filter(
        ({ accountProfileId, key }) => accountProfileId === stalled.id && key === "accountRead",
      )).toHaveLength(1);

      releaseStalledAccount();
      await withinDeadline((async () => {
        while (
          service.dispatchAccounts().find(({ id }) => id === stalled.id)?.usage.state !== "ready"
        ) {
          await Bun.sleep(1);
        }
      })(), 500);
      expect(service.dispatchAccounts().find(({ id }) => id === stalled.id)?.usage.state)
        .toBe("ready");
      expect(router.requests.filter(
        ({ accountProfileId, key }) => accountProfileId === stalled.id && key === "accountRead",
      )).toHaveLength(1);
    } finally {
      releaseStalledAccount();
      await service.shutdown();
      database.close();
    }
  });

  test("a positioned rate-limit notification wins over an older refresh response", async () => {
    const { database, router, service, store } = await fixture();
    try {
      const created = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      store.updateAuthState(created.id, "signedIn", new Date("2026-07-19T12:00:00.000Z"));
      let injected = false;
      router.beforeRequest = ({ accountProfileId, key }) => {
        if (key !== "accountRateLimitsRead" || injected) return;
        injected = true;
        const generation = router.generation(accountProfileId);
        if (generation === null) throw new Error("fake runtime generation missing");
        consumeNotification(service, accountProfileId, {
          generation,
          streamPosition: 2,
          method: "account/rateLimits/updated",
          params: {
            rateLimits: {
              limitId: "live-limit",
              primary: {
                usedPercent: 99,
                windowDurationMins: 300,
                resetsAt: 1_800_000_000,
              },
              rateLimitReachedType: "rate_limit_reached",
            },
          },
        });
      };

      const candidates = await service.refreshChatAccountCandidates();
      expect(candidates).toEqual([{
        id: created.id,
        selected: true,
        budget: "exhausted",
        remainingPercent: 0,
      }]);
      expect(service.dispatchAccounts()[0]?.usage).toMatchObject({
        state: "ready",
        limits: [{ id: "live-limit", primary: { usedPercent: 99 }, reached: true }],
      });
      const generation = router.generation(created.id);
      if (generation === null) throw new Error("fake runtime generation missing");
      expect(service.hasRateLimitProofSince(created.id, {
        generation,
        streamPosition: 2,
      })).toBeTrue();
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("a failed rate-limit read cannot erase a newer positioned notification", async () => {
    const { database, router, service, store } = await fixture();
    try {
      const created = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      store.updateAuthState(created.id, "signedIn", new Date("2026-07-19T12:00:00.000Z"));
      router.failures.set("accountRateLimitsRead", new Error("fixture rate-limit read failed"));
      let injected = false;
      router.beforeRequest = ({ accountProfileId, key }) => {
        if (key !== "accountRateLimitsRead" || injected) return;
        injected = true;
        const generation = router.generation(accountProfileId);
        if (generation === null) throw new Error("fake runtime generation missing");
        consumeNotification(service, accountProfileId, {
          generation,
          streamPosition: 2,
          method: "account/rateLimits/updated",
          params: {
            rateLimits: {
              limitId: "live-limit",
              primary: {
                usedPercent: 99,
                windowDurationMins: 300,
                resetsAt: 1_800_000_000,
              },
              rateLimitReachedType: "rate_limit_reached",
            },
          },
        });
      };

      const candidates = await service.refreshChatAccountCandidates();
      expect(candidates).toEqual([{
        id: created.id,
        selected: true,
        budget: "exhausted",
        remainingPercent: 0,
      }]);
      expect(service.dispatchAccounts()[0]?.usage).toMatchObject({
        state: "ready",
        limits: [{ id: "live-limit", primary: { usedPercent: 99 }, reached: true }],
      });
      const generation = router.generation(created.id);
      if (generation === null) throw new Error("fake runtime generation missing");
      expect(service.hasRateLimitProofSince(created.id, {
        generation,
        streamPosition: 2,
      })).toBeTrue();
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("manual refresh preserves newer exhaustion while token usage is still pending", async () => {
    const { database, router, service, store } = await fixture();
    try {
      const created = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      store.updateAuthState(created.id, "signedIn", new Date("2026-07-19T12:00:00.000Z"));
      let announceRateResponse: () => void = () => undefined;
      let announceTokenRequest: () => void = () => undefined;
      let releaseTokenRequest: () => void = () => undefined;
      const rateResponded = new Promise<void>((resolve) => {
        announceRateResponse = resolve;
      });
      const tokenEntered = new Promise<void>((resolve) => {
        announceTokenRequest = resolve;
      });
      const tokenRelease = new Promise<void>((resolve) => {
        releaseTokenRequest = resolve;
      });
      router.afterPositionedResponse = ({ key }) => {
        if (key === "accountRateLimitsRead") announceRateResponse();
      };
      router.beforeRequest = async ({ key }) => {
        if (key !== "accountUsageRead") return;
        announceTokenRequest();
        await tokenRelease;
      };

      const refresh = service.execute({
        type: "account.refresh",
        accountProfileId: created.id,
      });
      await Promise.all([rateResponded, tokenEntered]);
      const generation = router.generation(created.id);
      if (generation === null) throw new Error("fake runtime generation missing");
      consumeNotification(service, created.id, {
        generation,
        streamPosition: 2,
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            limitId: "live-limit",
            primary: {
              usedPercent: 99,
              windowDurationMins: 300,
              resetsAt: 1_800_000_000,
            },
            rateLimitReachedType: "rate_limit_reached",
          },
        },
      });
      releaseTokenRequest();

      expect(await refresh).toEqual({ type: "accepted" });
      expect(service.dispatchAccounts()[0]?.usage).toMatchObject({
        state: "ready",
        limits: [{ id: "live-limit", primary: { usedPercent: 99 }, reached: true }],
        tokens: { state: "ready", lifetimeTokens: "101" },
      });
      expect(service.hasRateLimitProofSince(created.id, {
        generation,
        streamPosition: 2,
      })).toBeTrue();
      const candidates = await service.refreshChatAccountCandidates();
      expect(candidates).toEqual([{
        id: created.id,
        selected: true,
        budget: "exhausted",
        remainingPercent: 0,
      }]);
      expect(rankChatAccountCandidates(candidates, created.id, [])).toEqual([]);
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("a sparse notification during manual refresh preserves unaffected limit buckets", async () => {
    const { database, router, service, store } = await fixture();
    try {
      const created = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      store.updateAuthState(created.id, "signedIn", new Date("2026-07-19T12:00:00.000Z"));
      await service.refreshDispatchAccounts();
      const generation = router.generation(created.id);
      if (generation === null) throw new Error("fake runtime generation missing");
      consumeNotification(service, created.id, {
        generation,
        streamPosition: 2,
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            limitId: "secondary-limit",
            primary: {
              usedPercent: 100,
              windowDurationMins: 300,
              resetsAt: 1_800_000_000,
            },
            rateLimitReachedType: "rate_limit_reached",
          },
        },
      });
      expect(service.dispatchAccounts()[0]?.usage).toMatchObject({
        state: "ready",
        limits: [
          { id: "limit-0001", primary: { usedPercent: 10 }, reached: false },
          { id: "secondary-limit", primary: { usedPercent: 100 }, reached: true },
        ],
      });

      let announceRateResponse: () => void = () => undefined;
      let announceTokenRequest: () => void = () => undefined;
      let releaseTokenRequest: () => void = () => undefined;
      const rateResponded = new Promise<void>((resolve) => {
        announceRateResponse = resolve;
      });
      const tokenEntered = new Promise<void>((resolve) => {
        announceTokenRequest = resolve;
      });
      const tokenRelease = new Promise<void>((resolve) => {
        releaseTokenRequest = resolve;
      });
      router.afterPositionedResponse = ({ key }) => {
        if (key === "accountRateLimitsRead") announceRateResponse();
      };
      router.beforeRequest = async ({ key }) => {
        if (key !== "accountUsageRead") return;
        announceTokenRequest();
        await tokenRelease;
      };

      const refresh = service.execute({
        type: "account.refresh",
        accountProfileId: created.id,
      });
      await Promise.all([rateResponded, tokenEntered]);
      consumeNotification(service, created.id, {
        generation,
        streamPosition: 3,
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            limitId: "limit-0001",
            primary: {
              usedPercent: 20,
              windowDurationMins: 300,
              resetsAt: 1_800_000_000,
            },
            rateLimitReachedType: null,
          },
        },
      });
      releaseTokenRequest();

      expect(await refresh).toEqual({ type: "accepted" });
      expect(service.dispatchAccounts()[0]?.usage).toMatchObject({
        state: "ready",
        limits: [
          { id: "limit-0001", primary: { usedPercent: 20 }, reached: false },
          { id: "secondary-limit", primary: { usedPercent: 100 }, reached: true },
        ],
        tokens: { state: "ready", lifetimeTokens: "101" },
      });
      const candidates = await service.refreshChatAccountCandidates();
      expect(candidates).toEqual([{
        id: created.id,
        selected: true,
        budget: "exhausted",
        remainingPercent: 0,
      }]);
      expect(rankChatAccountCandidates(candidates, created.id, [])).toEqual([]);
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("manual refresh rejection cannot erase a newer exhaustion notification", async () => {
    const { database, router, service, store } = await fixture();
    try {
      const created = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      store.updateAuthState(created.id, "signedIn", new Date("2026-07-19T12:00:00.000Z"));
      router.failures.set("accountRateLimitsRead", new Error("fixture rate-limit read failed"));
      let injected = false;
      router.beforeRequest = ({ accountProfileId, key }) => {
        if (key !== "accountRateLimitsRead" || injected) return;
        injected = true;
        const generation = router.generation(accountProfileId);
        if (generation === null) throw new Error("fake runtime generation missing");
        consumeNotification(service, accountProfileId, {
          generation,
          streamPosition: 2,
          method: "account/rateLimits/updated",
          params: {
            rateLimits: {
              limitId: "live-limit",
              primary: {
                usedPercent: 100,
                windowDurationMins: 300,
                resetsAt: 1_800_000_000,
              },
              rateLimitReachedType: "rate_limit_reached",
            },
          },
        });
      };

      expect(await service.execute({
        type: "account.refresh",
        accountProfileId: created.id,
      })).toEqual({ type: "accepted" });
      const generation = router.generation(created.id);
      if (generation === null) throw new Error("fake runtime generation missing");
      expect(service.dispatchAccounts()[0]?.usage).toMatchObject({
        state: "ready",
        limits: [{ id: "live-limit", primary: { usedPercent: 100 }, reached: true }],
        tokens: { state: "ready", lifetimeTokens: "101" },
      });
      expect(service.hasRateLimitProofSince(created.id, {
        generation,
        streamPosition: 2,
      })).toBeTrue();
      const candidates = await service.refreshChatAccountCandidates();
      expect(rankChatAccountCandidates(candidates, created.id, [])).toEqual([]);
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("dispatch refresh preserves a notification that arrives during account read", async () => {
    const { database, router, service, store } = await fixture();
    try {
      const created = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      store.updateAuthState(created.id, "signedIn", new Date("2026-07-19T12:00:00.000Z"));
      router.failures.set("accountRateLimitsRead", new Error("fixture rate-limit read failed"));
      let injected = false;
      router.beforeRequest = ({ accountProfileId, key }) => {
        if (key !== "accountRead" || injected) return;
        injected = true;
        const generation = router.generation(accountProfileId);
        if (generation === null) throw new Error("fake runtime generation missing");
        consumeNotification(service, accountProfileId, {
          generation,
          streamPosition: 2,
          method: "account/rateLimits/updated",
          params: {
            rateLimits: {
              limitId: "live-limit",
              primary: {
                usedPercent: 100,
                windowDurationMins: 300,
                resetsAt: 1_800_000_000,
              },
              rateLimitReachedType: "rate_limit_reached",
            },
          },
        });
      };

      const candidates = await service.refreshChatAccountCandidates();
      expect(router.requests.some(({ key }) => key === "accountRateLimitsRead")).toBeTrue();
      expect(candidates).toEqual([{
        id: created.id,
        selected: true,
        budget: "exhausted",
        remainingPercent: 0,
      }]);
      expect(service.dispatchAccounts()[0]?.usage).toMatchObject({
        state: "ready",
        limits: [{ id: "live-limit", primary: { usedPercent: 100 }, reached: true }],
      });
      const generation = router.generation(created.id);
      if (generation === null) throw new Error("fake runtime generation missing");
      expect(service.hasRateLimitProofSince(created.id, {
        generation,
        streamPosition: 2,
      })).toBeTrue();
      expect(rankChatAccountCandidates(candidates, created.id, [])).toEqual([]);
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("expires invalidated Codex sessions from manual and dispatch refresh", async () => {
    const { database, events, router, service, store } = await fixture();
    try {
      const created = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      const background = accountResult(
        await service.execute({ type: "account.create", label: "Personal" }),
      );
      store.updateAuthState(created.id, "signedIn", new Date("2026-07-19T12:00:00.000Z"));
      store.updateAuthState(background.id, "signedIn", new Date("2026-07-19T12:00:00.000Z"));
      router.failures.set(
        "accountRateLimitsRead",
        new CodexRemoteResponseError(-32_603, "authentication_invalid"),
      );

      expect(await service.execute({
        type: "account.refresh",
        accountProfileId: created.id,
      })).toEqual({ type: "accepted" });

      expect(store.find(created.id)?.authState).toBe("expired");
      expect(await service.refreshDispatchAccounts()).toEqual([]);
      expect(store.find(background.id)?.authState).toBe("expired");
      expect(service.dispatchAccounts()).toEqual([]);
      const latest = events.findLast(
        (event): event is Extract<AccountEvent, { type: "account.upserted" }> =>
          event.type === "account.upserted" && event.account.id === created.id,
      );
      expect(latest?.account).toMatchObject({
        authState: "expired",
        login: { state: "idle" },
      });
      expect(latest?.account).not.toHaveProperty("usage");
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("keeps an expired session inert until a new authorized login succeeds", async () => {
    const { database, router, service, store } = await fixture();
    try {
      const account = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      store.updateAuthState(account.id, "signedIn", new Date("2026-07-19T12:00:00.000Z"));
      router.failures.set(
        "accountRateLimitsRead",
        new CodexRemoteResponseError(-32_603, "authentication_invalid"),
      );
      await service.execute({ type: "account.refresh", accountProfileId: account.id });
      expect(store.find(account.id)?.authState).toBe("expired");

      const generation = router.generation(account.id);
      if (generation === null) throw new Error("fake runtime generation missing");
      consumeNotification(service, account.id, {
        generation,
        streamPosition: 1,
        method: "account/updated",
        params: { authMode: "chatgpt", planType: "pro" },
      });
      consumeNotification(service, account.id, {
        generation,
        streamPosition: 2,
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            limitId: "stale-limit",
            primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          },
        },
      });
      expect(store.find(account.id)?.authState).toBe("expired");
      expect(service.dispatchAccounts()).toEqual([]);

      router.failures.clear();
      const requestsBeforeCheck = router.requests.length;
      await service.execute({ type: "account.refresh", accountProfileId: account.id });
      expect(router.requests).toHaveLength(requestsBeforeCheck);
      expect(store.find(account.id)?.authState).toBe("expired");

      await service.execute({
        type: "account.login.start",
        accountProfileId: account.id,
        mode: "browser",
      });
      consumeNotification(service, account.id, {
        generation,
        streamPosition: 3,
        method: "account/login/completed",
        params: { loginId: "login-0001", success: true },
      });
      for (let attempts = 0; attempts < 100; attempts += 1) {
        if (store.find(account.id)?.authState === "signedIn") break;
        await Bun.sleep(1);
      }
      expect(store.find(account.id)?.authState).toBe("signedIn");
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("prefers token invalidation over a concurrent generic usage failure", async () => {
    const { database, router, service, store } = await fixture();
    try {
      const account = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      store.updateAuthState(account.id, "signedIn", new Date("2026-07-19T12:00:00.000Z"));
      router.failures.set("accountRateLimitsRead", new Error("temporary rate-limit failure"));
      router.failures.set(
        "accountUsageRead",
        new CodexRemoteResponseError(-32_603, "authentication_invalid"),
      );

      expect(await service.execute({
        type: "account.refresh",
        accountProfileId: account.id,
      })).toEqual({ type: "accepted" });
      expect(store.find(account.id)?.authState).toBe("expired");
      expect(service.dispatchAccounts()).toEqual([]);
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("keeps concurrent account reads, limits, homes, and events isolated", async () => {
    const { database, events, router, service } = await fixture();
    try {
      const first = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      const second = accountResult(await service.execute({ type: "account.create", label: "Personal" }));
      const refreshed = await Promise.all([
        service.execute({ type: "account.refresh", accountProfileId: first.id }),
        service.execute({ type: "account.refresh", accountProfileId: second.id }),
      ]);
      expect(refreshed).toEqual([{ type: "accepted" }, { type: "accepted" }]);
      const latest = new Map<string, AccountSummary>();
      for (const event of events) {
        if (event.type === "account.upserted") latest.set(event.account.id, event.account);
      }
      const refreshedFirst = latest.get(first.id);
      const refreshedSecond = latest.get(second.id);
      if (refreshedFirst === undefined || refreshedSecond === undefined) {
        throw new Error("refreshed account events were not projected");
      }

      expect(refreshedFirst.identityLabel).toBe("0001@example.test");
      expect(refreshedSecond.identityLabel).toBe("0002@example.test");
      expect(refreshedFirst).not.toHaveProperty("usage");
      expect(refreshedFirst).not.toHaveProperty("models");
      expect(refreshedSecond).not.toHaveProperty("usage");
      expect(refreshedSecond).not.toHaveProperty("models");
      const routing = new Map(service.dispatchAccounts().map((account) => [account.id, account]));
      expect(routing.get(first.id)?.usage).toMatchObject({
        state: "ready",
        limits: [{ id: "limit-0001", primary: { usedPercent: 10 } }],
        tokens: { state: "ready", lifetimeTokens: "101", currentStreakDays: "3" },
      });
      expect(routing.get(second.id)?.usage).toMatchObject({
        state: "ready",
        limits: [{ id: "limit-0002", primary: { usedPercent: 20 } }],
        tokens: { state: "ready", lifetimeTokens: "202", currentStreakDays: "3" },
      });
      expect(router.paths.get(first.id)?.codexHome).not.toBe(router.paths.get(second.id)?.codexHome);
      for (const request of router.requests) {
        expect([first.id, second.id]).toContain(request.accountProfileId);
      }
      expect(latest.get(first.id)?.identityLabel).toBe("0001@example.test");
      expect(latest.get(second.id)?.identityLabel).toBe("0002@example.test");
    } finally {
      database.close();
    }
  });

  test("keeps same-account session requests on the conservative serialized tail", async () => {
    const { database, router, service, store } = await fixture();
    try {
      const account = accountResult(
        await service.execute({ type: "account.create", label: "Work" }),
      );
      store.updateAuthState(account.id, "signedIn", new Date("2026-07-19T12:00:00.000Z"));
      let activeRequests = 0;
      let maximumActiveRequests = 0;
      let enteredRequests = 0;
      let announceFirst: () => void = () => undefined;
      let releaseFirst: () => void = () => undefined;
      const firstEntered = new Promise<void>((resolve) => {
        announceFirst = resolve;
      });
      const firstRelease = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      router.beforeRequest = async ({ key }) => {
        if (key !== "threadList") return;
        enteredRequests += 1;
        activeRequests += 1;
        maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
        if (enteredRequests === 1) {
          announceFirst();
          await firstRelease;
        }
        activeRequests -= 1;
      };
      const input = {
        cursor: null,
        limit: 64,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["appServer"],
        archived: false,
      } satisfies PinnedCodexRequestInput<"threadList">;

      const first = service.requestSession(account.id, "threadList", input);
      await firstEntered;
      const second = service.requestSession(account.id, "threadList", input);
      await Bun.sleep(0);
      expect(enteredRequests).toBe(1);
      expect(router.requests.filter(({ key }) => key === "threadList")).toHaveLength(1);

      releaseFirst();
      await Promise.all([first, second]);
      expect(enteredRequests).toBe(2);
      expect(maximumActiveRequests).toBe(1);
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("converges recovery callers on one durable live session generation", async () => {
    const { database, router, service, store } = await fixture();
    try {
      const account = accountResult(
        await service.execute({ type: "account.create", label: "Work" }),
      );
      expect(await rejection(service.ensureSessionRuntime(account.id)))
        .toMatchObject({ code: "capability_unavailable", retryable: false });
      store.updateAuthState(
        account.id,
        "signedIn",
        new Date("2026-07-19T12:00:00.000Z"),
      );

      const [first, duplicate] = await Promise.all([
        service.ensureSessionRuntime(account.id),
        service.ensureSessionRuntime(account.id),
      ]);
      expect(first).toEqual({ generation: 1 });
      expect(duplicate).toEqual(first);
      expect(store.find(account.id)?.processGeneration).toBe(1);
      expect(router.generation(account.id)).toBe(1);

      await router.stop(account.id);
      const recovered = await service.ensureSessionRuntime(account.id);
      expect(recovered).toEqual({ generation: 2 });
      expect(store.find(account.id)?.processGeneration).toBe(2);
      expect(router.generation(account.id)).toBe(2);
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("preserves the response position for session hydration requests", async () => {
    const { database, router, service, store } = await fixture();
    try {
      const account = accountResult(
        await service.execute({ type: "account.create", label: "Work" }),
      );
      store.updateAuthState(account.id, "signedIn", new Date("2026-07-19T12:00:00.000Z"));
      const input = {
        cursor: null,
        limit: 64,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["appServer"],
        archived: false,
      } satisfies PinnedCodexRequestInput<"threadList">;

      const response = await service.requestSessionWithResponsePosition(
        account.id,
        "threadList",
        input,
      );

      expect(response).toEqual({
        generation: 1,
        output: { data: [], nextCursor: null, backwardsCursor: null },
        streamPosition: 1,
      });
      expect(router.requests.findLast(({ key }) => key === "threadList")).toEqual({
        accountProfileId: account.id,
        expectedGeneration: undefined,
        input,
        key: "threadList",
      });
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("opens browser login inside the gateway without projecting its URL", async () => {
    const { database, events, opener, router, service } = await fixture();
    try {
      const account = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      const result = await service.execute({
        type: "account.login.start",
        accountProfileId: account.id,
        mode: "browser",
      });
      expect(result).toEqual({ type: "accepted" });
      const waiting = events.findLast(
        (event): event is Extract<AccountEvent, { type: "account.upserted" }> =>
          event.type === "account.upserted" && event.account.id === account.id,
      );
      expect(waiting?.account.login.state).toBe("waitingForBrowser");
      expect(opener.opened).toEqual(["https://auth.openai.com/0001?private=opaque"]);
      expect(JSON.stringify({ events, result })).not.toContain("auth.openai.com");
      expect(JSON.stringify({ events, result })).not.toContain("private=opaque");

      const generation = router.generation(account.id);
      if (generation === null) throw new Error("fake runtime generation missing");
      const notification: CodexNotification = {
        generation,
        streamPosition: 1,
        method: "account/login/completed",
        params: { loginId: "login-0001", success: true },
      };
      consumeNotification(service, account.id, notification);
      for (let attempts = 0; attempts < 100; attempts += 1) {
        const latest = events.findLast(
          (event): event is Extract<AccountEvent, { type: "account.upserted" }> =>
            event.type === "account.upserted" && event.account.id === account.id,
        );
        if (latest?.account.authState === "signedIn") break;
        await Bun.sleep(1);
      }
      const latest = events.findLast(
        (event): event is Extract<AccountEvent, { type: "account.upserted" }> =>
          event.type === "account.upserted" && event.account.id === account.id,
      );
      expect(latest?.account.authState).toBe("signedIn");
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("projects a device code live without retaining it or its URL in an operation receipt", async () => {
    const { database, events, opener, service } = await fixture();
    try {
      const account = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      const command = {
        type: "account.login.start",
        accountProfileId: account.id,
        mode: "deviceCode",
      } as const;
      const result = await service.execute(command);
      expect(result).toEqual({ type: "accepted" });
      const waiting = events.findLast(
        (event): event is Extract<AccountEvent, { type: "account.upserted" }> =>
          event.type === "account.upserted" && event.account.id === account.id,
      );
      expect(waiting?.account.login).toMatchObject({
        state: "waitingForDeviceCode",
        userCode: "DEVICE-0001",
      });
      if (waiting?.account.login.state !== "waitingForDeviceCode") {
        throw new Error("device-code login state was not projected");
      }
      expect(waiting.account.login.startedAt).toMatch(/^2026-07-19T/u);
      expect(opener.opened).toEqual([
        "https://auth.openai.com/device/0001?private=opaque",
      ]);

      const receipts = new OperationReceiptStore(database, new Uint8Array(32).fill(0x73));
      expect(receipts.begin("op_device_login", command)).toEqual({ state: "new" });
      receipts.complete({
        version: 3,
        operationId: "op_device_login",
        ok: true,
        result,
      });
      const stored = database
        .query<{ response_json: string }, []>(
          "SELECT response_json FROM operation_receipts WHERE operation_id = 'op_device_login'",
        )
        .get();
      expect(stored?.response_json).not.toContain("DEVICE-0001");
      expect(stored?.response_json).not.toContain("auth.openai.com");
      expect(stored?.response_json).toContain('"type":"accepted"');
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("reconciles account state when Codex reports that a cancel raced login completion", async () => {
    const { database, events, router, service } = await fixture();
    try {
      const account = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      await service.execute({
        type: "account.login.start",
        accountProfileId: account.id,
        mode: "browser",
      });
      const loginGeneration = router.generation(account.id);
      if (loginGeneration === null) throw new Error("fake runtime generation missing");
      router.cancelStatus = "notFound";
      await service.execute({ type: "account.login.cancel", accountProfileId: account.id });

      const latest = events.findLast(
        (event): event is Extract<AccountEvent, { type: "account.upserted" }> =>
          event.type === "account.upserted" && event.account.id === account.id,
      );
      expect(latest?.account).toMatchObject({
        authState: "signedIn",
        identityLabel: "0001@example.test",
        login: { state: "idle" },
      });
      expect(router.requests.filter(({ key }) => key === "accountRead")).toHaveLength(1);
      expect(router.requests.find(({ key }) => key === "accountLoginCancel")).toMatchObject({
        expectedGeneration: loginGeneration,
        input: { loginId: "login-0001" },
      });
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("expires login authority as soon as its process generation enters backoff", async () => {
    const { database, events, router, service, store } = await fixture();
    try {
      const account = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      await service.execute({
        type: "account.login.start",
        accountProfileId: account.id,
        mode: "browser",
      });
      const generation = router.generation(account.id);
      if (generation === null) throw new Error("fake runtime generation missing");

      service.handleRuntimeState(account.id, {
        type: "backing_off",
        generation,
        attempt: 1,
        delayMs: 100,
      });

      expect(service.execute({
        type: "account.login.open",
        accountProfileId: account.id,
      })).rejects.toMatchObject({ code: "not_found" });
      expect(service.execute({
        type: "account.login.cancel",
        accountProfileId: account.id,
      })).rejects.toMatchObject({ code: "not_found" });
      expect(store.find(account.id)?.authState).toBe("unknown");
      const latest = events.findLast(
        (event): event is Extract<AccountEvent, { type: "account.upserted" }> =>
          event.type === "account.upserted" && event.account.id === account.id,
      );
      expect(latest?.account).toMatchObject({
        authState: "unknown",
        login: { state: "failed" },
        runtime: { state: "backingOff", generation },
      });
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("recovers in the same process after persistence failures consume skipped generations", async () => {
    const {
      callbackOwners,
      database,
      events,
      processes,
      router,
      service,
      store,
    } = await generationRecoveryFixture();
    try {
      const account = accountResult(
        await service.execute({ type: "account.create", label: "Recovery" }),
      );
      database.exec(`
        CREATE TRIGGER fail_generation_before_commit
        BEFORE UPDATE OF process_generation ON account_profiles
        BEGIN
          SELECT RAISE(ABORT, 'fixture generation persistence failure');
        END
      `);

      expect(await rejection(service.execute({
        type: "runtime.restartAccount",
        accountProfileId: account.id,
      }))).toMatchObject({
        action: "restartRuntime",
        code: "runtime_unavailable",
        retryable: true,
      });
      expect(store.find(account.id)?.processGeneration).toBe(0);
      // The first launch plus its two bounded recovery attempts consume three
      // generations before returning the retryable result.
      expect(router.generation(account.id)).toBe(3);
      expect(router.isRunning(account.id)).toBeFalse();
      expect(processes).toEqual([]);
      expect(callbackOwners.size).toBe(0);

      expect(await rejection(service.execute({
        type: "runtime.restartAccount",
        accountProfileId: account.id,
      }))).toMatchObject({
        action: "restartRuntime",
        code: "runtime_unavailable",
        retryable: true,
      });
      expect(store.find(account.id)?.processGeneration).toBe(0);
      // A later explicit restart receives the configured two-attempt restart
      // budget. It has no additional unsupervised initial launch.
      expect(router.generation(account.id)).toBe(5);
      expect(router.isRunning(account.id)).toBeFalse();
      expect(processes).toEqual([]);
      expect(callbackOwners.size).toBe(0);
      expect(events.some(
        (event) =>
          event.type === "account.upserted" &&
          event.account.id === account.id &&
          [1, 2, 3, 4, 5].includes(event.account.runtime.generation),
      )).toBeFalse();

      database.exec("DROP TRIGGER fail_generation_before_commit");
      expect(await service.execute({
        type: "runtime.restartAccount",
        accountProfileId: account.id,
      })).toEqual({ type: "accepted" });

      expect(store.find(account.id)?.processGeneration).toBe(6);
      expect(router.generation(account.id)).toBe(6);
      expect(router.isRunning(account.id)).toBeTrue();
      expect(processes.map(({ generation }) => generation)).toEqual([6]);
      expect([...callbackOwners.keys()]).toEqual([6]);
      for (const skippedGeneration of [1, 2, 3, 4, 5]) {
        expect(callbackOwners.has(skippedGeneration)).toBeFalse();
      }
    } finally {
      database.exec("DROP TRIGGER IF EXISTS fail_generation_before_commit");
      await service.shutdown();
      database.close();
    }
  });

  test("recovers above a committed generation when later creation-hook work fails", async () => {
    const {
      callbackOwners,
      database,
      events,
      processes,
      router,
      service,
      store,
    } = await generationRecoveryFixture();
    try {
      const account = accountResult(
        await service.execute({ type: "account.create", label: "Post-commit recovery" }),
      );
      store.updateProcessGeneration(
        account.id,
        4,
        new Date("2026-07-29T11:00:00.000Z"),
      );
      store.updateAuthState(
        account.id,
        "signingIn",
        new Date("2026-07-29T11:01:00.000Z"),
      );
      database.exec(`
        CREATE TRIGGER fail_generation_hook_after_commit
        BEFORE UPDATE OF auth_state ON account_profiles
        BEGIN
          SELECT RAISE(ABORT, 'fixture post-commit hook failure');
        END
      `);

      expect(await rejection(service.execute({
        type: "runtime.restartAccount",
        accountProfileId: account.id,
      }))).toMatchObject({
        action: "restartRuntime",
        code: "runtime_unavailable",
        retryable: true,
      });
      expect(store.find(account.id)).toMatchObject({
        authState: "signingIn",
        processGeneration: 7,
      });
      expect(router.generation(account.id)).toBe(7);
      expect(router.isRunning(account.id)).toBeFalse();
      expect(processes).toEqual([]);
      expect(callbackOwners.size).toBe(0);
      expect(events.findLast(
        (event) =>
          event.type === "account.upserted" &&
          event.account.id === account.id &&
          event.account.runtime.generation === 7,
      )).toMatchObject({
        type: "account.upserted",
        account: { runtime: { state: "failed", generation: 7 } },
      });

      database.exec("DROP TRIGGER fail_generation_hook_after_commit");
      expect(await service.execute({
        type: "runtime.restartAccount",
        accountProfileId: account.id,
      })).toEqual({ type: "accepted" });

      expect(store.find(account.id)).toMatchObject({
        authState: "unknown",
        processGeneration: 8,
      });
      expect(router.generation(account.id)).toBe(8);
      expect(router.isRunning(account.id)).toBeTrue();
      expect(processes.map(({ generation }) => generation)).toEqual([8]);
      expect([...callbackOwners.keys()]).toEqual([8]);
      for (const skippedGeneration of [5, 6, 7]) {
        expect(callbackOwners.has(skippedGeneration)).toBeFalse();
      }
    } finally {
      database.exec("DROP TRIGGER IF EXISTS fail_generation_hook_after_commit");
      await service.shutdown();
      database.close();
    }
  });

  test("normalizes a persisted transient login and resumes above the durable generation floor", async () => {
    const { database, events, router, service, store } = await fixture();
    try {
      const created = store.create("Interrupted", new Date("2026-07-19T11:00:00.000Z"));
      store.updateProcessGeneration(created.id, 4, new Date("2026-07-19T11:01:00.000Z"));
      store.updateAuthState(created.id, "signingIn", new Date("2026-07-19T11:02:00.000Z"));

      expect((await service.initialize())[0]).toMatchObject({
        id: created.id,
        authState: "unknown",
        login: { state: "failed" },
      });
      for (let attempts = 0; attempts < 100 && router.generation(created.id) !== 5; attempts += 1) {
        await Bun.sleep(1);
      }
      expect(router.generation(created.id)).toBe(5);
      expect(store.find(created.id)?.processGeneration).toBe(5);

      service.handleRuntimeState(created.id, { type: "running", generation: 5 });
      for (let attempts = 0; attempts < 100; attempts += 1) {
        const latest = events.findLast(
          (event): event is Extract<AccountEvent, { type: "account.upserted" }> =>
            event.type === "account.upserted" && event.account.id === created.id,
        );
        if (latest?.account.authState === "signedIn") break;
        await Bun.sleep(1);
      }
      const latest = events.findLast(
        (event): event is Extract<AccountEvent, { type: "account.upserted" }> =>
          event.type === "account.upserted" && event.account.id === created.id,
      );
      expect(latest?.account).toMatchObject({ authState: "signedIn", login: { state: "idle" } });
      expect(store.find(created.id)?.processGeneration).toBe(5);
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("refreshes a persisted signed-in account's bounded remaining capacity after startup", async () => {
    const { database, events, service, store } = await fixture();
    try {
      const created = store.create("Connected", new Date("2026-07-19T11:00:00.000Z"));
      store.updateAuthState(created.id, "signedIn", new Date("2026-07-19T11:01:00.000Z"));

      expect((await service.initialize())[0]).toMatchObject({
        id: created.id,
        authState: "signedIn",
        usageRemainingPercent: null,
      });
      for (let attempts = 0; attempts < 200; attempts += 1) {
        const latest = events.findLast(
          (event): event is Extract<AccountEvent, { type: "account.upserted" }> =>
            event.type === "account.upserted" && event.account.id === created.id,
        );
        if (latest?.account.usageRemainingPercent === 90) break;
        await Bun.sleep(1);
      }
      expect(events.findLast(
        (event): event is Extract<AccountEvent, { type: "account.upserted" }> =>
          event.type === "account.upserted" && event.account.id === created.id,
      )?.account).toMatchObject({
        authState: "signedIn",
        usageRemainingPercent: 90,
      });
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("never projects stale remaining capacity after a provider sign-out", async () => {
    const { database, events, router, service, store } = await fixture();
    try {
      const created = accountResult(
        await service.execute({ type: "account.create", label: "Connected" }),
      );
      store.updateAuthState(created.id, "signedIn", new Date("2026-07-19T11:01:00.000Z"));
      await service.refreshDispatchAccounts();
      const generation = router.generation(created.id);
      if (generation === null) throw new Error("fake runtime generation missing");

      consumeNotification(service, created.id, {
        generation,
        streamPosition: 2,
        method: "account/updated",
        params: { authMode: null, planType: null },
      });

      expect(events.findLast(
        (event): event is Extract<AccountEvent, { type: "account.upserted" }> =>
          event.type === "account.upserted" && event.account.id === created.id,
      )?.account).toMatchObject({
        authState: "signedOut",
        usageRemainingPercent: null,
      });
      expect(service.dispatchAccounts()).toEqual([]);
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("expires the renderer usage percentage without waiting for another provider fact", async () => {
    let nowMs = Date.UTC(2026, 6, 19, 12, 0, 0);
    const scheduler = new FakeUsageProjectionScheduler();
    const { database, events, service, store } = await fixture({
      now: () => new Date(nowMs),
      usageProjectionScheduler: scheduler,
    });
    try {
      const created = accountResult(
        await service.execute({ type: "account.create", label: "Connected" }),
      );
      store.updateAuthState(created.id, "signedIn", new Date(nowMs));
      await service.refreshDispatchAccounts();
      expect(events.findLast(
        (event): event is Extract<AccountEvent, { type: "account.upserted" }> =>
          event.type === "account.upserted" && event.account.id === created.id,
      )?.account.usageRemainingPercent).toBe(90);

      nowMs += dispatchBudgetFreshnessMs;
      expect(scheduler.runNext()).toBe(dispatchBudgetFreshnessMs);
      for (let attempts = 0; attempts < 100; attempts += 1) {
        const remaining = events.findLast(
          (event): event is Extract<AccountEvent, { type: "account.upserted" }> =>
            event.type === "account.upserted" && event.account.id === created.id,
        )?.account.usageRemainingPercent;
        if (remaining === null) break;
        await Bun.sleep(1);
      }
      expect(events.findLast(
        (event): event is Extract<AccountEvent, { type: "account.upserted" }> =>
          event.type === "account.upserted" && event.account.id === created.id,
      )?.account.usageRemainingPercent).toBeNull();
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("isolates an unsafe profile while valid accounts and Settings become ready", async () => {
    const { controlPlanePath, database, events, router, service, store } = await fixture();
    try {
      const interrupted = store.create("Interrupted", new Date("2026-07-19T11:00:00.000Z"));
      store.updateProcessGeneration(interrupted.id, 4, new Date("2026-07-19T11:01:00.000Z"));
      store.updateAuthState(interrupted.id, "signingIn", new Date("2026-07-19T11:02:00.000Z"));
      const invalid = store.create("Invalid", new Date("2026-07-19T11:03:00.000Z"));
      const invalidLayout = accountProfileLayout(controlPlanePath, invalid.id);
      const outside = join(controlPlanePath, "..", "outside-profile");
      await mkdir(invalidLayout.accountsRoot, { recursive: true });
      await mkdir(outside, { recursive: true });
      await symlink(outside, invalidLayout.profileRoot);

      expect(await service.initialize()).toHaveLength(2);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const invalidFailure = events.findLast((event) =>
          event.type === "account.upserted" &&
          event.account.id === invalid.id &&
          event.account.runtime.state === "failed"
        );
        if (router.generation(interrupted.id) === 5 && invalidFailure !== undefined) break;
        await Bun.sleep(1);
      }
      expect(router.paths.has(interrupted.id)).toBeTrue();
      expect(router.paths.has(invalid.id)).toBeFalse();
      expect(store.find(interrupted.id)?.processGeneration).toBe(5);
      expect(events.findLast((event) =>
        event.type === "account.upserted" && event.account.id === invalid.id
      )).toMatchObject({
        account: {
          runtime: {
            state: "failed",
            generation: 0,
            canRestart: true,
          },
        },
      });

      await rm(invalidLayout.profileRoot, { force: true });
      expect(await service.execute({
        type: "runtime.restartAccount",
        accountProfileId: invalid.id,
      })).toEqual({ type: "accepted" });
      expect(router.paths.has(invalid.id)).toBeTrue();
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("removal retains local Codex data until a separately previewed post-tombstone deletion", async () => {
    const {
      controlPlanePath,
      database,
      events,
      localDataRemover,
      service,
      store,
    } = await fixture();
    try {
      const account = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      const layout = accountProfileLayout(controlPlanePath, account.id);
      await writeFile(join(layout.codexHome, "auth.json"), "opaque fixture credential");

      await service.execute({
        type: "account.login.start",
        accountProfileId: account.id,
        mode: "browser",
      });
      const blocked = await service.execute({
        type: "account.remove.preview",
        accountProfileId: account.id,
      });
      expect(blocked).toMatchObject({
        type: "accountRemovalPreview",
        preview: { blockers: ["loginActive"], canRemove: false, localDataState: "present" },
      });

      await service.execute({
        type: "account.login.cancel",
        accountProfileId: account.id,
      });
      const previewResult = await service.execute({
        type: "account.remove.preview",
        accountProfileId: account.id,
      });
      if (previewResult.type !== "accountRemovalPreview") throw new Error("expected removal preview");
      expect(previewResult.preview.canRemove).toBeTrue();
      await service.execute({
        type: "account.remove",
        accountProfileId: account.id,
        expectedRevision: previewResult.preview.accountRevision,
      });
      expect(store.find(account.id)).toBeNull();
      expect(store.findAny(account.id)).toMatchObject({
        localDataState: "present",
        identityLabel: null,
        planLabel: null,
        authState: "signedOut",
      });
      expect((await stat(join(layout.codexHome, "auth.json"))).isFile()).toBeTrue();
      expect(events.find(
        (event): event is Extract<AccountEvent, { type: "accountLocalData.upserted" }> =>
          event.type === "accountLocalData.upserted",
      )?.localData).toMatchObject({ id: account.id, label: "Work" });
      events.length = 0;
      expect(await service.initialize()).toEqual([]);
      expect(events.find(
        (event): event is Extract<AccountEvent, { type: "accountLocalData.upserted" }> =>
          event.type === "accountLocalData.upserted",
      )?.localData).toMatchObject({ id: account.id, label: "Work" });

      const deletionPreview = await service.execute({
        type: "account.localData.delete.preview",
        accountProfileId: account.id,
      });
      if (deletionPreview.type !== "accountLocalDataDeletionPreview") {
        throw new Error("expected local-data deletion preview");
      }
      expect(deletionPreview.preview.deletes).toEqual({
        credentials: true,
        sessionsAndHistory: true,
        configuration: true,
        logs: true,
      });
      await service.execute({
        type: "account.localData.delete",
        accountProfileId: account.id,
        expectedRevision: deletionPreview.preview.accountRevision,
      });
      expect(store.findAny(account.id)?.localDataState).toBe("deleted");
      expect(stat(layout.codexHome)).rejects.toMatchObject({ code: "ENOENT" });
      expect(events).toContainEqual({
        type: "accountLocalData.removed",
        accountProfileId: account.id,
      });
      expect(localDataRemover.calls).toContainEqual({
        action: "delete",
        accountProfileId: account.id,
        expectedRevision: deletionPreview.preview.accountRevision,
      });
    } finally {
      database.close();
    }
  });

  test("marks local data deleted only after the native remover succeeds", async () => {
    const {
      controlPlanePath,
      database,
      events,
      localDataRemover,
      service,
      store,
    } = await fixture();
    try {
      const account = accountResult(
        await service.execute({ type: "account.create", label: "Work" }),
      );
      const layout = accountProfileLayout(controlPlanePath, account.id);
      await writeFile(join(layout.codexHome, "auth.json"), "opaque credential");
      const removalPreview = await service.execute({
        type: "account.remove.preview",
        accountProfileId: account.id,
      });
      if (removalPreview.type !== "accountRemovalPreview") {
        throw new Error("expected removal preview");
      }
      await service.execute({
        type: "account.remove",
        accountProfileId: account.id,
        expectedRevision: removalPreview.preview.accountRevision,
      });
      const deletionPreview = await service.execute({
        type: "account.localData.delete.preview",
        accountProfileId: account.id,
      });
      if (deletionPreview.type !== "accountLocalDataDeletionPreview") {
        throw new Error("expected local-data deletion preview");
      }
      const expectedRevision = deletionPreview.preview.accountRevision;

      localDataRemover.failure = new Error("fixture helper rejection with private path");
      expect(await rejection(service.execute({
        type: "account.localData.delete",
        accountProfileId: account.id,
        expectedRevision,
      }))).toMatchObject({
        action: "retry",
        code: "operation_failed",
        message: "This account's local Codex data could not be deleted.",
        retryable: true,
      });
      expect(store.findAny(account.id)).toMatchObject({
        localDataState: "present",
        revision: expectedRevision,
      });
      expect(await stat(join(layout.codexHome, "auth.json"))).toBeDefined();
      expect(events).not.toContainEqual({
        type: "accountLocalData.removed",
        accountProfileId: account.id,
      });

      localDataRemover.failure = null;
      let entered: (() => void) | undefined;
      const helperEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release: (() => void) | undefined;
      const helperRelease = new Promise<void>((resolve) => {
        release = resolve;
      });
      localDataRemover.operation = async (
        accountProfileId,
      ) => {
        entered?.();
        await helperRelease;
        await rm(
          accountProfileLayout(
            controlPlanePath,
            accountProfileId,
          ).codexHome,
          { recursive: true, force: true },
        );
      };
      const deletion = service.execute({
        type: "account.localData.delete",
        accountProfileId: account.id,
        expectedRevision,
      });
      await helperEntered;
      expect(store.findAny(account.id)).toMatchObject({
        localDataState: "present",
        revision: expectedRevision,
      });
      expect(events).not.toContainEqual({
        type: "accountLocalData.removed",
        accountProfileId: account.id,
      });
      release?.();
      await deletion;
      expect(store.findAny(account.id)?.localDataState).toBe("deleted");
      expect(events).toContainEqual({
        type: "accountLocalData.removed",
        accountProfileId: account.id,
      });
    } finally {
      database.close();
    }
  });

  test("rejects local-data deletion preview while a profile remains active", async () => {
    const { database, service } = await fixture();
    try {
      const account = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      expect(service.execute({
        type: "account.localData.delete.preview",
        accountProfileId: account.id,
      })).rejects.toMatchObject({ code: "policy_denied" });
    } finally {
      database.close();
    }
  });
});

function hasCode(error: unknown, expected: string): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === expected
  );
}
