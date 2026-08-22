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
  accountWeeklyUsage,
  type AccountRuntimeRouterPort,
  type AccountUsageProjectionScheduler,
  type ExternalUrlOpener,
} from "../src/accounts/account-service";
import type {
  AccountUsageState,
  RateLimitSummary,
} from "../src/internal-contracts";
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
  ArchiveAdmissionGate,
  type AccountRemovalAdmissionHandle,
  type ArchiveAdmissionHandle,
} from "../src/accounts/archive-admission-gate";
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
import {
  ProviderThreadArchiveJournalV57,
  providerThreadArchiveCompleteInventoryDigestV57,
} from "../src/state/provider-thread-archive-journal-v57";
import { ChatPaneStore } from "../src/state/chat-pane-store";

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

function readyUsage(limits: readonly RateLimitSummary[]): AccountUsageState {
  return {
    state: "ready",
    limits,
    tokens: { state: "unavailable" },
    updatedAt: "2026-08-20T12:00:00.000Z",
  };
}

function usageLimit(
  id: string,
  primary: RateLimitSummary["primary"],
  secondary: RateLimitSummary["secondary"] = null,
): RateLimitSummary {
  return {
    id,
    name: id,
    primary,
    secondary,
    individual: null,
    unlimited: false,
    reached: false,
  };
}

describe("weekly account usage projection", () => {
  const nowMs = Date.parse("2026-08-20T12:00:00.000Z");
  const resetsAt = "2026-08-21T20:00:00.000Z";

  test("selects the exact seven-day Codex window regardless of slot", () => {
    const weekly = {
      usedPercent: 42.4,
      windowDurationMinutes: 10_080,
      resetsAt,
    };
    expect(accountWeeklyUsage(readyUsage([
      usageLimit("codex", {
        usedPercent: 9,
        windowDurationMinutes: 300,
        resetsAt,
      }, weekly),
    ]), nowMs)).toEqual({ remainingPercent: 57.6, resetsAt });
    expect(accountWeeklyUsage(readyUsage([
      usageLimit("codex", weekly, {
        usedPercent: 9,
        windowDurationMinutes: 300,
        resetsAt,
      }),
    ]), nowMs)).toEqual({ remainingPercent: 57.6, resetsAt });
  });

  test("uses a single weekly window when an older server omits the Codex bucket id", () => {
    expect(accountWeeklyUsage(readyUsage([
      usageLimit("legacy", null, {
        usedPercent: 25,
        windowDurationMinutes: 10_080,
        resetsAt,
      }),
      usageLimit("other", {
        usedPercent: 5,
        windowDurationMinutes: 300,
        resetsAt,
      }),
    ]), nowMs)).toEqual({ remainingPercent: 75, resetsAt });
  });

  test("fails closed for ambiguous, expired, or reset-less weekly windows", () => {
    const weekly = {
      usedPercent: 25,
      windowDurationMinutes: 10_080,
      resetsAt,
    };
    expect(accountWeeklyUsage(readyUsage([
      usageLimit("first", weekly),
      usageLimit("second", weekly),
    ]), nowMs)).toBeNull();
    expect(accountWeeklyUsage(readyUsage([
      usageLimit("codex", { ...weekly, resetsAt: "2026-08-20T12:00:00.000Z" }),
    ]), nowMs)).toBeNull();
    expect(accountWeeklyUsage(readyUsage([
      usageLimit("codex", { ...weekly, resetsAt: null }),
    ]), nowMs)).toBeNull();
  });
});

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
  beforeEnsure: ((accountProfileId: string) => void | Promise<void>) | null = null;
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
    await this.beforeEnsure?.(accountProfileId);
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
  readonly archiveAdmissionGate: ArchiveAdmissionGate;
  readonly archiveQuiescenceCalls: Array<Readonly<{
    accountProfileId: string;
    expectedGeneration: number;
  }>> = [];
  archiveQuiescenceFailure: Error | null = null;
  afterArchiveQuiescenceCheck: (() => void) | null = null;
  readonly archiveProvisionalReleaseCalls: Array<Readonly<{
    accountProfileId: string;
    expectedGeneration: number;
  }>> = [];
  archiveProvisionalReleaseFailure: Error | null = null;
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

  constructor(archiveAdmissionGate: ArchiveAdmissionGate) {
    this.archiveAdmissionGate = archiveAdmissionGate;
  }

  assertArchiveTransitionQuiescent(
    accountProfileId: string,
    expectedGeneration: number,
  ): void {
    this.archiveAdmissionGate.assertOrdinaryAdmission(accountProfileId);
    this.archiveQuiescenceCalls.push({ accountProfileId, expectedGeneration });
    if (this.archiveQuiescenceFailure !== null) {
      throw this.archiveQuiescenceFailure;
    }
    if (
      !this.running.has(accountProfileId) ||
      this.generations.get(accountProfileId) !== expectedGeneration
    ) {
      throw new Error("the fake account runtime is not quiescent");
    }
    this.afterArchiveQuiescenceCheck?.();
  }

  assertArchiveTransitionProvisionalReleaseSafe(
    accountProfileId: string,
    expectedGeneration: number,
  ): void {
    this.archiveProvisionalReleaseCalls.push({
      accountProfileId,
      expectedGeneration,
    });
    if (this.archiveProvisionalReleaseFailure !== null) {
      throw this.archiveProvisionalReleaseFailure;
    }
  }

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

  async ensureArchiveRecovery(
    accountProfileId: string,
    paths: RuntimePaths,
    options: {
      readonly initialGeneration: number;
      readonly beforeCreate: (generation: number) => void | Promise<void>;
    },
    archiveHandle: ArchiveAdmissionHandle,
  ): Promise<unknown> {
    this.archiveAdmissionGate.require(archiveHandle, accountProfileId);
    const result = await this.ensure(accountProfileId, paths, options);
    this.archiveAdmissionGate.require(archiveHandle, accountProfileId);
    return result;
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
      case "scheduleInterpreterThreadStart":
      case "threadResume":
      case "threadArchive":
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
      case "configRequirementsRead":
      case "mcpServerStatusList":
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

  async requestArchiveRecoveryWithResponsePosition<
    K extends Extract<AccountRuntimeRequestKey, "threadArchive" | "threadList">,
  >(
    accountProfileId: string,
    archiveHandle: ArchiveAdmissionHandle,
    key: K,
    input: PinnedCodexRequestInput<K>,
    expectedGeneration: number,
  ) {
    this.archiveAdmissionGate.require(archiveHandle, accountProfileId);
    const response = await this.requestWithResponsePosition(
      accountProfileId,
      key,
      input,
      expectedGeneration,
    );
    this.archiveAdmissionGate.require(archiveHandle, accountProfileId);
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

  async fenceAccountRemovalGeneration(
    accountProfileId: string,
    removalHandle: AccountRemovalAdmissionHandle,
  ): Promise<"already_fenced" | "fenced"> {
    const descriptor = this.archiveAdmissionGate.requireAccountRemoval(
      removalHandle,
      accountProfileId,
    );
    const result = await this.fenceGeneration(
      accountProfileId,
      descriptor.expectedGeneration,
    );
    this.archiveAdmissionGate.requireAccountRemoval(
      removalHandle,
      accountProfileId,
    );
    return result;
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
    secondary: { usedPercent, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
    credits: null,
    individualLimit: null,
    planType: "pro",
    rateLimitReachedType: null,
  } as const;
}

async function fixture(
  options: Readonly<{
    containChatsBeforeRemoval?: (accountProfileId: string) => Promise<void>;
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
  const archiveAdmissionGate = new ArchiveAdmissionGate();
  const providerThreadArchiveJournalV57 = new ProviderThreadArchiveJournalV57(
    database,
    new Uint8Array(32).fill(57),
  );
  const router = new FakeRouter(archiveAdmissionGate);
  const opener = new FakeOpener();
  const localDataRemover =
    new FakeAccountProfileFileSystem(controlPlanePath);
  const events: AccountEvent[] = [];
  let clock = 0;
  const createService = (installArchiveReplay = true) => {
    const created = new AccountService({
      archiveAdmissionGate,
      assets: {
        bunBinary: process.execPath,
        codexBinary: "/fixture/codex",
        gitBinary: "/fixture/git/bin/git",
        gitRoot: "/fixture/git",
      },
      containChatsBeforeRemoval:
        options.containChatsBeforeRemoval ?? (() => Promise.resolve()),
      joinChatArchiveGenerationContainment: () => Promise.resolve(),
      controlPlanePath,
      controlPlaneDatabase: database,
      emit: (event) => events.push(structuredClone(event)),
      externalUrlOpener: opener,
      profileFileSystem: localDataRemover,
      providerThreadArchiveJournalV57,
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
    if (installArchiveReplay) created.installArchiveAdmissionReplayV57();
    return created;
  };
  const service = createService();
  return {
    archiveAdmissionGate,
    controlPlanePath,
    createService,
    database,
    events,
    localDataRemover,
    opener,
    providerThreadArchiveJournalV57,
    router,
    service,
    store,
  };
}

async function generationRecoveryFixture(options: Readonly<{
  beforeReplay?: (input: Readonly<{
    database: Database;
    journal: ProviderThreadArchiveJournalV57;
    store: AccountProfileStore;
  }>) => void;
}> = {}) {
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
  const archiveAdmissionGate = new ArchiveAdmissionGate();
  const providerThreadArchiveJournalV57 = new ProviderThreadArchiveJournalV57(
    database,
    new Uint8Array(32).fill(57),
  );
  options.beforeReplay?.({
    database,
    journal: providerThreadArchiveJournalV57,
    store,
  });
  const router = new AccountRuntimeRouter({
    archiveAdmissionGate,
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
  const profileFileSystem = new FakeAccountProfileFileSystem(controlPlanePath);
  service = new AccountService({
    archiveAdmissionGate,
    assets: {
      bunBinary: process.execPath,
      codexBinary: "/fixture/codex",
      gitBinary: "/fixture/git/bin/git",
      gitRoot: "/fixture/git",
    },
    containChatsBeforeRemoval: () => Promise.resolve(),
    joinChatArchiveGenerationContainment: () => Promise.resolve(),
    controlPlanePath,
    controlPlaneDatabase: database,
    emit: (event) => events.push(structuredClone(event)),
    profileFileSystem,
    providerThreadArchiveJournalV57,
    now: () => new Date(Date.UTC(2026, 6, 29, 12, 0, clock++)),
    router,
    store,
  });
  service.installArchiveAdmissionReplayV57();
  return {
    archiveAdmissionGate,
    callbackOwners,
    database,
    events,
    processes,
    profileFileSystem,
    providerThreadArchiveJournalV57,
    router,
    service,
    store,
  };
}

function accountResult(result: Awaited<ReturnType<AccountService['execute']>>): AccountSummary {
  if (result.type !== "account") throw new Error("expected an account result");
  return result.account;
}

function prepareArchiveTarget(
  input: Readonly<{
    database: Database;
    journal: ProviderThreadArchiveJournalV57;
    store: AccountProfileStore;
    accountProfileId: string;
    paneId: string;
    targetId: string;
    attemptId: string;
    now: Date;
    effectStarted?: boolean;
  }>,
) {
  const panes = new ChatPaneStore(input.database);
  panes.create({
    paneId: input.paneId,
    repository: {
      id: `repo_${"7".repeat(26)}`,
      name: "Archive fence",
      workingDirectory: "/fixture/archive-fence",
    },
    accountProfileId: input.accountProfileId,
    now: input.now,
  });
  input.database.query(`
    UPDATE chat_panes SET provider_account_profile_id = ?2,
      provider_thread_id = ?3, provider_restart_thread_id = ?4
    WHERE pane_id = ?1
  `).run(
    input.paneId,
    input.accountProfileId,
    `thread_${input.targetId}`,
    `restart_${input.targetId}`,
  );
  const profile = input.store.find(input.accountProfileId);
  if (profile === null) throw new Error("archive fixture profile disappeared");
  input.journal.prepareTarget({
    targetId: input.targetId,
    paneId: input.paneId,
    purpose: "pane_archive",
    paneRevision: 1,
    queueRevision: null,
    paneCasDigest: "1".repeat(64),
    queueCasDigest: null,
    accountProfileId: input.accountProfileId,
    accountProfileRevision: profile.revision,
    threadId: `thread_${input.targetId}`,
    restartThreadId: `restart_${input.targetId}`,
    binding: { kind: "none" },
    attempt: {
      attemptId: input.attemptId,
      generation: profile.processGeneration,
      accountProfileRevision: profile.revision,
      requestEvidenceDigest: "2".repeat(64),
      requestRevisionDigest: "3".repeat(64),
    },
    now: input.now,
  });
  if (input.effectStarted === true) {
    input.journal.markEffectStarted({
      attemptId: input.attemptId,
      effectEvidenceDigest: "4".repeat(64),
      effectRevisionDigest: "5".repeat(64),
      now: input.now,
    });
  }
  return input.journal.admissionDescriptor(input.targetId);
}

function prepareAccountRemovalCut(
  input: Readonly<{
    journal: ProviderThreadArchiveJournalV57;
    store: AccountProfileStore;
    accountProfileId: string;
    cutId: string;
    now: Date;
  }>,
) {
  const profile = input.store.find(input.accountProfileId);
  if (profile === null) throw new Error("removal fixture profile disappeared");
  input.journal.createCut({
    cutId: input.cutId,
    accountProfileId: input.accountProfileId,
    accountProfileRevision: profile.revision,
    sourceGeneration: profile.processGeneration,
    cause: "account_removal",
    initiatingAttemptId: null,
    predecessorCutId: null,
    identityEvidenceDigest: "6".repeat(64),
    identityRevisionDigest: "7".repeat(64),
    now: input.now,
  });
  const descriptor = input.journal.recoveryInventory()
    .removalAdmissionDescriptors.find(({ transitionId }) =>
      transitionId === input.cutId
    );
  if (descriptor === undefined) {
    throw new Error("removal fixture authority disappeared");
  }
  return descriptor;
}

function prepareFencedArchiveSuccessor(input: Readonly<{
  database: Database;
  journal: ProviderThreadArchiveJournalV57;
  store: AccountProfileStore;
  corruptProfilePostimage?: boolean;
}>) {
  const account = input.store.create(
    "Recovery",
    new Date("2026-07-29T11:00:00.000Z"),
  );
  input.store.updateProcessGeneration(
    account.id,
    1,
    new Date("2026-07-29T11:01:00.000Z"),
  );
  input.store.updateAuthState(
    account.id,
    "signedIn",
    new Date("2026-07-29T11:02:00.000Z"),
  );
  const targetId = "archtarget_coldrecovery01";
  const attemptId = "archattempt_coldrecovery01";
  const cutId = "archcut_coldrecovery01";
  prepareArchiveTarget({
    database: input.database,
    journal: input.journal,
    store: input.store,
    accountProfileId: account.id,
    paneId: "pane_coldrecovery01",
    targetId,
    attemptId,
    now: new Date("2026-07-29T11:03:00.000Z"),
    effectStarted: true,
  });
  const sourceProfile = input.store.find(account.id);
  if (sourceProfile === null) throw new Error("recovery fixture profile disappeared");
  input.journal.createCut({
    cutId,
    accountProfileId: account.id,
    accountProfileRevision: sourceProfile.revision,
    sourceGeneration: 1,
    cause: "lost_response",
    initiatingAttemptId: attemptId,
    predecessorCutId: null,
    identityEvidenceDigest: "6".repeat(64),
    identityRevisionDigest: "7".repeat(64),
    now: new Date("2026-07-29T11:04:00.000Z"),
  });
  input.journal.bindAttemptToCut(attemptId, cutId);
  input.journal.recordAmbiguous({
    attemptId,
    ambiguityEvidenceDigest: "8".repeat(64),
    ambiguityRevisionDigest: "9".repeat(64),
    now: new Date("2026-07-29T11:05:00.000Z"),
  });
  const successor = input.database.transaction(() => {
    const updated = input.store.updateProcessGeneration(
      account.id,
      2,
      new Date("2026-07-29T11:06:00.000Z"),
    );
    input.journal.recordFence({
      cutId,
      successorGeneration: 2,
      successorAccountProfileRevision: updated.profile.revision,
      fenceEvidenceDigest: "a".repeat(64),
      fenceRevisionDigest: "b".repeat(64),
      now: new Date("2026-07-29T11:06:00.000Z"),
    });
    return updated.profile;
  }).immediate();
  if (input.corruptProfilePostimage === true) {
    input.database.query(`
      UPDATE account_profiles
      SET process_generation = 1, revision = ?2
      WHERE profile_id = ?1
    `).run(account.id, sourceProfile.revision);
  }
  return Object.freeze({
    accountProfileId: account.id,
    attemptId,
    cutId,
    paneId: "pane_coldrecovery01",
    sourceProfileRevision: sourceProfile.revision,
    successorProfileRevision: successor.revision,
    targetId,
  });
}

function prepareContainedNotAppliedArchiveSuccessor(input: Readonly<{
  database: Database;
  journal: ProviderThreadArchiveJournalV57;
  store: AccountProfileStore;
}>) {
  const recovery = prepareFencedArchiveSuccessor(input);
  const member = {
    memberId: "archmember_coldrecovery01",
    cutId: recovery.cutId,
    paneId: recovery.paneId,
    paneRevision: 1,
    paneCasDigest: "1".repeat(64),
    threadId: `thread_${recovery.targetId}`,
    restartThreadId: `restart_${recovery.targetId}`,
    role: "target" as const,
    targetId: recovery.targetId,
    attemptId: recovery.attemptId,
    targetAttemptOrdinal: 1,
    action: "preserved_target" as const,
    binding: { kind: "none" as const },
    identityEvidenceDigest: "c".repeat(64),
    identityRevisionDigest: "d".repeat(64),
    now: new Date("2026-07-29T11:07:00.000Z"),
  };
  input.journal.addCutMember(member);
  input.journal.sealCutInventory({
    cutId: recovery.cutId,
    expectedMemberCount: 1,
    expectedInventoryDigest:
      providerThreadArchiveCompleteInventoryDigestV57([member]),
    enumerationAuthorityDigest: "e".repeat(64),
    sealRevisionDigest: "f".repeat(64),
    now: new Date("2026-07-29T11:08:00.000Z"),
  });
  input.journal.settleMember({
    memberId: member.memberId,
    settlementEvidenceDigest: "0".repeat(64),
    settlementRevisionDigest: "1".repeat(64),
    now: new Date("2026-07-29T11:09:00.000Z"),
  });
  input.journal.markCutContained({
    cutId: recovery.cutId,
    containmentEvidenceDigest: "2".repeat(64),
    containmentRevisionDigest: "3".repeat(64),
    now: new Date("2026-07-29T11:10:00.000Z"),
  });
  input.journal.recordReconciledNotApplied({
    attemptId: recovery.attemptId,
    outcomeEvidenceDigest: "4".repeat(64),
    outcomeRevisionDigest: "5".repeat(64),
    now: new Date("2026-07-29T11:11:00.000Z"),
  });
  return recovery;
}

describe("AccountService", () => {
  test("requires durable archive replay before startup can touch profiles or providers", async () => {
    const {
      createService,
      database,
      localDataRemover,
      router,
      service,
      store,
    } = await fixture();
    const uninstalled = createService(false);
    try {
      const profile = store.create(
        "Held",
        new Date("2026-07-19T11:00:00.000Z"),
      );
      store.updateAuthState(
        profile.id,
        "signedIn",
        new Date("2026-07-19T11:01:00.000Z"),
      );

      expect(() => uninstalled.initialize()).toThrow(
        "Provider archive admission replay must complete before account initialization",
      );
      await Bun.sleep(0);
      expect(localDataRemover.calls).toEqual([]);
      expect(router.paths.size).toBe(0);
      expect(router.requests).toEqual([]);
    } finally {
      await uninstalled.shutdown();
      await service.shutdown();
      database.close();
    }
  });

  test("installs and returns the exact verified replay snapshot before held-account startup", async () => {
    const {
      archiveAdmissionGate,
      createService,
      database,
      localDataRemover,
      providerThreadArchiveJournalV57: journal,
      router,
      service,
      store,
    } = await fixture();
    const targetAccount = store.create(
      "Target",
      new Date("2026-07-19T11:00:00.000Z"),
    );
    const removalAccount = store.create(
      "Removal",
      new Date("2026-07-19T11:00:01.000Z"),
    );
    for (const account of [targetAccount, removalAccount]) {
      store.updateProcessGeneration(
        account.id,
        1,
        new Date("2026-07-19T11:01:00.000Z"),
      );
      store.updateAuthState(
        account.id,
        "signedIn",
        new Date("2026-07-19T11:02:00.000Z"),
      );
    }
    const targetDescriptor = prepareArchiveTarget({
      database,
      journal,
      store,
      accountProfileId: targetAccount.id,
      paneId: "pane_replaytarget01",
      targetId: "archtarget_replaytarget01",
      attemptId: "archattempt_replaytarget01",
      now: new Date("2026-07-19T11:03:00.000Z"),
    });
    const removalDescriptor = prepareAccountRemovalCut({
      journal,
      store,
      accountProfileId: removalAccount.id,
      cutId: "archcut_replayremoval01",
      now: new Date("2026-07-19T11:04:00.000Z"),
    });
    const expected = journal.recoveryInventory();
    const replayed = createService(false);
    try {
      const installed = replayed.installArchiveAdmissionReplayV57(expected);

      expect(installed).toEqual(expected);
      expect(installed).not.toBe(expected);
      expect(await replayed.initialize()).toHaveLength(2);
      await Bun.sleep(0);
      const targetHandle = replayed.archiveTransitionHandleV57(
        targetDescriptor.transitionId,
      );
      const removalHandle = replayed.accountRemovalHandleV57(
        removalDescriptor.transitionId,
      );
      expect(archiveAdmissionGate.require(targetHandle)).toEqual(targetDescriptor);
      expect(archiveAdmissionGate.requireAccountRemoval(removalHandle)).toEqual(
        removalDescriptor,
      );
      expect(localDataRemover.calls).toEqual([]);
      expect(router.paths.size).toBe(0);
      expect(router.requests).toEqual([]);

      archiveAdmissionGate.release(targetHandle);
      archiveAdmissionGate.releaseAccountRemoval(removalHandle);
      expect(archiveAdmissionGate.isHeld(targetAccount.id)).toBeFalse();
      expect(archiveAdmissionGate.isHeld(removalAccount.id)).toBeFalse();
    } finally {
      await replayed.shutdown();
      await service.shutdown();
      database.close();
    }
  });

  test("rejects a stale verified replay snapshot before retaining any authority and remains retryable", async () => {
    const {
      archiveAdmissionGate,
      createService,
      database,
      localDataRemover,
      providerThreadArchiveJournalV57: journal,
      router,
      service,
      store,
    } = await fixture();
    const account = store.create(
      "Stale snapshot",
      new Date("2026-07-19T11:00:00.000Z"),
    );
    store.updateProcessGeneration(
      account.id,
      1,
      new Date("2026-07-19T11:01:00.000Z"),
    );
    store.updateAuthState(
      account.id,
      "signedIn",
      new Date("2026-07-19T11:02:00.000Z"),
    );
    const first = prepareArchiveTarget({
      database,
      journal,
      store,
      accountProfileId: account.id,
      paneId: "pane_replaystale01",
      targetId: "archtarget_replaystale01",
      attemptId: "archattempt_replaystale01",
      now: new Date("2026-07-19T11:03:00.000Z"),
    });
    const stale = journal.recoveryInventory();
    const second = prepareArchiveTarget({
      database,
      journal,
      store,
      accountProfileId: account.id,
      paneId: "pane_replaystale02",
      targetId: "archtarget_replaystale02",
      attemptId: "archattempt_replaystale02",
      now: new Date("2026-07-19T11:04:00.000Z"),
    });
    const holdEvents: boolean[] = [];
    const unsubscribe = archiveAdmissionGate.subscribe(
      account.id,
      (held) => holdEvents.push(held),
    );
    const replayed = createService(false);
    try {
      expect(() => replayed.installArchiveAdmissionReplayV57(stale)).toThrow(
        "Provider archive admission replay does not match the verified recovery inventory",
      );
      expect(holdEvents).toEqual([]);
      expect(archiveAdmissionGate.isHeld(account.id)).toBeFalse();
      expect(() => replayed.archiveTransitionHandleV57(first.transitionId))
        .toThrow("The provider archive recovery authority is unavailable.");
      expect(() => replayed.archiveTransitionHandleV57(second.transitionId))
        .toThrow("The provider archive recovery authority is unavailable.");
      expect(() => replayed.initialize()).toThrow(
        "Provider archive admission replay must complete before account initialization",
      );
      expect(localDataRemover.calls).toEqual([]);
      expect(router.paths.size).toBe(0);
      expect(router.requests).toEqual([]);

      const current = journal.recoveryInventory();
      expect(replayed.installArchiveAdmissionReplayV57(current)).toEqual(current);
      const firstHandle = replayed.archiveTransitionHandleV57(first.transitionId);
      const secondHandle = replayed.archiveTransitionHandleV57(second.transitionId);
      expect(holdEvents).toEqual([true]);
      expect(() => replayed.installArchiveAdmissionReplayV57(current)).toThrow(
        "Provider archive admission replay was already installed",
      );
      expect(replayed.archiveTransitionHandleV57(first.transitionId))
        .toBe(firstHandle);
      expect(replayed.archiveTransitionHandleV57(second.transitionId))
        .toBe(secondHandle);

      archiveAdmissionGate.release(firstHandle);
      archiveAdmissionGate.release(secondHandle);
    } finally {
      unsubscribe();
      await replayed.shutdown();
      await service.shutdown();
      database.close();
    }
  });

  test("rolls prior holds back when keyed replay collides with a provisional", async () => {
    const {
      archiveAdmissionGate,
      createService,
      database,
      providerThreadArchiveJournalV57: journal,
      service,
      store,
    } = await fixture();
    const firstAccount = store.create("First", new Date("2026-07-19T11:00:00.000Z"));
    const secondAccount = store.create("Second", new Date("2026-07-19T11:00:01.000Z"));
    for (const account of [firstAccount, secondAccount]) {
      store.updateProcessGeneration(
        account.id,
        1,
        new Date("2026-07-19T11:01:00.000Z"),
      );
      store.updateAuthState(
        account.id,
        "signedIn",
        new Date("2026-07-19T11:02:00.000Z"),
      );
    }
    const first = prepareArchiveTarget({
      database,
      journal,
      store,
      accountProfileId: firstAccount.id,
      paneId: "pane_replayfirst01",
      targetId: "archtarget_replayfirst01",
      attemptId: "archattempt_replayfirst01",
      now: new Date("2026-07-19T11:03:00.000Z"),
    });
    const second = prepareArchiveTarget({
      database,
      journal,
      store,
      accountProfileId: secondAccount.id,
      paneId: "pane_replaysecond01",
      targetId: "archtarget_replaysecond01",
      attemptId: "archattempt_replaysecond01",
      now: new Date("2026-07-19T11:04:00.000Z"),
    });
    const conflicting = archiveAdmissionGate.retainProvisional({
      accountProfileId: second.accountProfileId,
      paneId: second.paneId,
      purpose: second.purpose,
      transitionId: second.transitionId,
    });
    const expected = journal.recoveryInventory();
    const replayed = createService(false);
    try {
      expect(() => replayed.installArchiveAdmissionReplayV57(expected)).toThrow();
      expect(archiveAdmissionGate.isHeld(firstAccount.id)).toBeFalse();
      expect(archiveAdmissionGate.isHeld(secondAccount.id)).toBeTrue();
      expect(() => replayed.archiveTransitionHandleV57(first.transitionId))
        .toThrow("The provider archive recovery authority is unavailable.");

      archiveAdmissionGate.abortProvisional(conflicting);
      expect(replayed.installArchiveAdmissionReplayV57(expected)).toEqual(expected);
      expect(archiveAdmissionGate.require(
        replayed.archiveTransitionHandleV57(first.transitionId),
      )).toEqual(first);
      expect(archiveAdmissionGate.require(
        replayed.archiveTransitionHandleV57(second.transitionId),
      )).toEqual(second);
      expect(() => replayed.installArchiveAdmissionReplayV57())
        .toThrow("Provider archive admission replay was already installed");

      archiveAdmissionGate.release(
        replayed.archiveTransitionHandleV57(first.transitionId),
      );
      archiveAdmissionGate.release(
        replayed.archiveTransitionHandleV57(second.transitionId),
      );
    } finally {
      await replayed.shutdown();
      await service.shutdown();
      database.close();
    }
  });

  test("retains provisional archive admission in the quiescence-check turn", async () => {
    const {
      archiveAdmissionGate,
      database,
      providerThreadArchiveJournalV57: journal,
      router,
      service,
      store,
    } = await fixture();
    try {
      const account = accountResult(
        await service.execute({ type: "account.create", label: "Work" }),
      );
      store.updateAuthState(
        account.id,
        "signedIn",
        new Date("2026-07-19T12:00:00.000Z"),
      );

      const notQuiescent = new Error("provider work is still active");
      router.archiveQuiescenceFailure = notQuiescent;
      expect(await rejection(service.beginArchiveTransitionProvisional({
        accountProfileId: account.id,
        paneId: "pane_quiescence01",
        purpose: "pane_archive",
        transitionId: "archtarget_quiescence01",
      }))).toBe(notQuiescent);
      expect(router.archiveQuiescenceCalls).toEqual([{
        accountProfileId: account.id,
        expectedGeneration: 1,
      }]);
      expect(archiveAdmissionGate.isHeld(account.id)).toBeFalse();
      expect(journal.recoveryInventory().targets).toEqual([]);

      router.archiveQuiescenceFailure = null;
      let heldInNextMicrotask: boolean | null = null;
      router.afterArchiveQuiescenceCheck = () => {
        queueMicrotask(() => {
          heldInNextMicrotask = archiveAdmissionGate.isHeld(account.id);
        });
      };
      const provisional = await service.beginArchiveTransitionProvisional({
        accountProfileId: account.id,
        paneId: "pane_quiescence01",
        purpose: "pane_archive",
        transitionId: "archtarget_quiescence01",
      });
      await Bun.sleep(0);
      expect(heldInNextMicrotask).toBeTrue();
      expect(archiveAdmissionGate.isHeld(account.id)).toBeTrue();

      const invalidated = new Error("provider callback invalidated quiescence");
      router.archiveProvisionalReleaseFailure = invalidated;
      const fenceFailure = new Error("fixture exact fence failed");
      router.fenceFailure = fenceFailure;
      expect(await rejection(service.abortArchiveTransitionProvisional(
        provisional.handle,
      ))).toBe(fenceFailure);
      expect(router.archiveProvisionalReleaseCalls).toEqual([{
        accountProfileId: account.id,
        expectedGeneration: 1,
      }]);
      expect(router.fenceCalls).toEqual([{
        accountProfileId: account.id,
        expectedGeneration: 1,
      }]);
      expect(archiveAdmissionGate.isHeld(account.id)).toBeTrue();
      expect(router.isRunning(account.id)).toBeTrue();

      router.fenceFailure = null;
      router.beforeFence = () => {
        expect(archiveAdmissionGate.isHeld(account.id)).toBeTrue();
        router.archiveProvisionalReleaseFailure = null;
      };
      await service.abortArchiveTransitionProvisional(provisional.handle);
      expect(router.fenceCalls).toEqual([
        { accountProfileId: account.id, expectedGeneration: 1 },
        { accountProfileId: account.id, expectedGeneration: 1 },
      ]);
      expect(router.archiveProvisionalReleaseCalls).toEqual([
        { accountProfileId: account.id, expectedGeneration: 1 },
        { accountProfileId: account.id, expectedGeneration: 1 },
        { accountProfileId: account.id, expectedGeneration: 1 },
      ]);
      expect(archiveAdmissionGate.isHeld(account.id)).toBeFalse();
      expect(router.isRunning(account.id)).toBeFalse();
      expect(router.requests).toEqual([]);

      await service.requestSession(account.id, "threadList", {
        cursor: null,
        limit: 64,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["appServer"],
        archived: false,
      });
      expect(router.generation(account.id)).toBe(2);
      expect(store.find(account.id)?.processGeneration).toBe(2);
      expect(router.requests.filter(({ key }) => key === "threadList"))
        .toHaveLength(1);
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("tracks gapless archive authority replacement and rejects stale release", async () => {
    const {
      archiveAdmissionGate,
      database,
      providerThreadArchiveJournalV57: journal,
      router,
      service,
      store,
    } = await fixture();
    try {
      const account = accountResult(
        await service.execute({ type: "account.create", label: "Work" }),
      );
      store.updateAuthState(
        account.id,
        "signedIn",
        new Date("2026-07-19T12:00:00.000Z"),
      );
      const provisional = await service.beginArchiveTransitionProvisional({
        accountProfileId: account.id,
        paneId: "pane_livearchive01",
        purpose: "pane_archive",
        transitionId: "archtarget_livearchive01",
      });
      const descriptor = prepareArchiveTarget({
        database,
        journal,
        store,
        accountProfileId: account.id,
        paneId: "pane_livearchive01",
        targetId: "archtarget_livearchive01",
        attemptId: "archattempt_livearchive01",
        now: new Date("2026-07-19T12:01:00.000Z"),
      });
      const prepared = service.promoteArchiveTransition(
        provisional.handle,
        descriptor.transitionId,
      );
      journal.markEffectStarted({
        attemptId: "archattempt_livearchive01",
        effectEvidenceDigest: "4".repeat(64),
        effectRevisionDigest: "5".repeat(64),
        now: new Date("2026-07-19T12:02:00.000Z"),
      });
      const effectStarted = service.replaceArchiveTransition(
        prepared,
        descriptor.transitionId,
      );
      const pendingComponent = journal.terminalCleanupComponent(
        descriptor.transitionId,
      );

      expect(service.archiveTransitionHandleV57(descriptor.transitionId))
        .toBe(effectStarted);
      expect(() => service.releaseArchiveTransition(
        descriptor.transitionId,
        prepared,
        pendingComponent,
      ))
        .toThrow("A stale provider archive authority cannot release its successor.");
      expect(archiveAdmissionGate.isHeld(account.id)).toBeTrue();
      expect(() => service.releaseArchiveTransition(
        descriptor.transitionId,
        effectStarted,
        pendingComponent,
      )).toThrow();

      journal.recordDirectApplied({
        attemptId: "archattempt_livearchive01",
        responseGeneration: 1,
        responseStreamPosition: 1,
        outcomeEvidenceDigest: "6".repeat(64),
        outcomeRevisionDigest: "7".repeat(64),
        now: new Date("2026-07-19T12:03:00.000Z"),
      });
      const staleComponent = journal.terminalCleanupComponent(
        descriptor.transitionId,
      );
      journal.markTargetCommitted({
        targetId: descriptor.transitionId,
        commitEvidenceDigest: "8".repeat(64),
        commitRevisionDigest: "9".repeat(64),
        now: new Date("2026-07-19T12:04:00.000Z"),
      });
      expect(() => service.releaseArchiveTransition(
        descriptor.transitionId,
        effectStarted,
        staleComponent,
      )).toThrow("Provider archive terminal cleanup authority changed.");
      expect(journal.reopenTarget(descriptor.transitionId).status)
        .toBe("committed");
      expect(service.archiveTransitionHandleV57(descriptor.transitionId))
        .toBe(effectStarted);
      expect(archiveAdmissionGate.isHeld(account.id)).toBeTrue();
      const committedComponent = journal.terminalCleanupComponent(
        descriptor.transitionId,
      );
      expect(committedComponent).toEqual({
        accountProfileId: account.id,
        targetIds: [descriptor.transitionId],
        cutIds: [],
        allTargetsCommitted: true,
      });
      const releaseTaint = new Error(
        "fixture callback tainted the final archive generation",
      );
      router.archiveProvisionalReleaseFailure = releaseTaint;
      expect(() => service.releaseArchiveTransition(
        descriptor.transitionId,
        effectStarted,
        committedComponent,
      )).toThrow(releaseTaint);
      expect(router.archiveProvisionalReleaseCalls.at(-1)).toEqual({
        accountProfileId: account.id,
        expectedGeneration: 1,
      });
      expect(journal.reopenTarget(descriptor.transitionId).status)
        .toBe("committed");
      expect(service.archiveTransitionHandleV57(descriptor.transitionId))
        .toBe(effectStarted);
      expect(archiveAdmissionGate.isHeld(account.id)).toBeTrue();
      expect(router.requests).toEqual([]);
      expect(await rejection(service.requestSession(account.id, "threadList", {
        cursor: null,
        limit: 64,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["appServer"],
        archived: false,
      }))).toMatchObject({ code: "runtime_unavailable" });
      expect(router.requests).toEqual([]);
      router.archiveProvisionalReleaseFailure = null;
      database.exec(`
        CREATE TRIGGER fail_committed_archive_target_delete
        BEFORE DELETE ON chat_provider_thread_archive_targets_v57
        BEGIN SELECT RAISE(ABORT, 'fixture target delete failure'); END;
      `);
      expect(() => service.releaseArchiveTransition(
        descriptor.transitionId,
        effectStarted,
        committedComponent,
      )).toThrow();
      expect(journal.reopenTarget(descriptor.transitionId).status)
        .toBe("committed");
      expect(service.archiveTransitionHandleV57(descriptor.transitionId))
        .toBe(effectStarted);
      expect(archiveAdmissionGate.isHeld(account.id)).toBeTrue();
      expect(() => archiveAdmissionGate.assertOrdinaryAdmission(account.id))
        .toThrow();

      database.exec("DROP TRIGGER fail_committed_archive_target_delete");
      expect(service.releaseArchiveTransition(
        descriptor.transitionId,
        effectStarted,
        committedComponent,
      )).toEqual({
        deletedTargetIds: [descriptor.transitionId],
        deletedCutIds: [],
      });
      expect(archiveAdmissionGate.isHeld(account.id)).toBeFalse();
      expect(() => journal.reopenTarget(descriptor.transitionId)).toThrow();
      expect(service.releaseArchiveTransition(
        descriptor.transitionId,
        effectStarted,
        committedComponent,
      )).toEqual({ deletedTargetIds: [], deletedCutIds: [] });
    } finally {
      database.exec("DROP TRIGGER IF EXISTS fail_committed_archive_target_delete");
      await service.shutdown();
      database.close();
    }
  });

  test("releases incomplete peers independently and deletes the exact committed component", async () => {
    const runOrder = async (releaseFirst: "first" | "second") => {
      const {
        archiveAdmissionGate,
        createService,
        database,
        providerThreadArchiveJournalV57: journal,
        service,
        store,
      } = await fixture();
      let replayed: AccountService | null = null;
      try {
        const account = accountResult(
          await service.execute({ type: "account.create", label: "Shared" }),
        );
        store.updateAuthState(
          account.id,
          "signedIn",
          new Date("2026-07-19T13:00:00.000Z"),
        );
        expect(await service.ensureSessionRuntime(account.id)).toEqual({
          generation: 1,
        });
        const targets = [
          {
            attemptId: "archattempt_sharedrelease01",
            memberId: "archmember_sharedrelease01",
            paneId: "pane_sharedrelease01",
            targetId: "archtarget_sharedrelease01",
          },
          {
            attemptId: "archattempt_sharedrelease02",
            memberId: "archmember_sharedrelease02",
            paneId: "pane_sharedrelease02",
            targetId: "archtarget_sharedrelease02",
          },
        ] as const;
        for (const [index, target] of targets.entries()) {
          prepareArchiveTarget({
            database,
            journal,
            store,
            accountProfileId: account.id,
            paneId: target.paneId,
            targetId: target.targetId,
            attemptId: target.attemptId,
            now: new Date(`2026-07-19T13:0${index + 1}:00.000Z`),
            effectStarted: true,
          });
        }
        const sourceProfile = store.find(account.id);
        if (sourceProfile === null) throw new Error("shared profile disappeared");
        const cutId = "archcut_sharedrelease01";
        journal.createCut({
          cutId,
          accountProfileId: account.id,
          accountProfileRevision: sourceProfile.revision,
          sourceGeneration: sourceProfile.processGeneration,
          cause: "lost_response",
          initiatingAttemptId: targets[0].attemptId,
          predecessorCutId: null,
          identityEvidenceDigest: "6".repeat(64),
          identityRevisionDigest: "7".repeat(64),
          now: new Date("2026-07-19T13:03:00.000Z"),
        });
        journal.bindAllAffectedTargets(cutId);
        for (const [index, target] of targets.entries()) {
          journal.recordAmbiguous({
            attemptId: target.attemptId,
            ambiguityEvidenceDigest: `${index + 8}`.repeat(64),
            ambiguityRevisionDigest: `${index + 1}`.repeat(64),
            now: new Date(`2026-07-19T13:0${index + 4}:00.000Z`),
          });
        }
        database.transaction(() => {
          const successor = store.updateProcessGeneration(
            account.id,
            sourceProfile.processGeneration + 1,
            new Date("2026-07-19T13:06:00.000Z"),
          ).profile;
          journal.recordFence({
            cutId,
            successorGeneration: successor.processGeneration,
            successorAccountProfileRevision: successor.revision,
            fenceEvidenceDigest: "a".repeat(64),
            fenceRevisionDigest: "b".repeat(64),
            now: new Date("2026-07-19T13:06:00.000Z"),
          });
        }).immediate();
        const members = targets.map((target, index) => ({
          memberId: target.memberId,
          cutId,
          paneId: target.paneId,
          paneRevision: 1,
          paneCasDigest: "1".repeat(64),
          threadId: `thread_${target.targetId}`,
          restartThreadId: `restart_${target.targetId}`,
          role: "target" as const,
          targetId: target.targetId,
          attemptId: target.attemptId,
          targetAttemptOrdinal: 1,
          action: "preserved_target" as const,
          binding: { kind: "none" as const },
          identityEvidenceDigest: `${index + 2}`.repeat(64),
          identityRevisionDigest: `${index + 4}`.repeat(64),
          now: new Date(`2026-07-19T13:0${index + 7}:00.000Z`),
        }));
        for (const member of members) journal.addCutMember(member);
        journal.sealCutInventory({
          cutId,
          expectedMemberCount: members.length,
          expectedInventoryDigest:
            providerThreadArchiveCompleteInventoryDigestV57(members),
          enumerationAuthorityDigest: "c".repeat(64),
          sealRevisionDigest: "d".repeat(64),
          now: new Date("2026-07-19T13:09:00.000Z"),
        });
        for (const [index, member] of members.entries()) {
          journal.settleMember({
            memberId: member.memberId,
            settlementEvidenceDigest: `${index + 5}`.repeat(64),
            settlementRevisionDigest: `${index + 7}`.repeat(64),
            now: new Date(`2026-07-19T13:1${index}:00.000Z`),
          });
        }
        journal.markCutContained({
          cutId,
          containmentEvidenceDigest: "e".repeat(64),
          containmentRevisionDigest: "f".repeat(64),
          now: new Date("2026-07-19T13:12:00.000Z"),
        });
        for (const [index, target] of targets.entries()) {
          journal.recordReconciledApplied({
            attemptId: target.attemptId,
            responseGeneration: sourceProfile.processGeneration + 1,
            responseStreamPosition: index + 1,
            outcomeEvidenceDigest: `${index + 3}`.repeat(64),
            outcomeRevisionDigest: `${index + 5}`.repeat(64),
            now: new Date(`2026-07-19T13:1${index + 3}:00.000Z`),
          });
        }

        replayed = createService(false);
        replayed.installArchiveAdmissionReplayV57();
        const committedHandles = new Map<string, ArchiveAdmissionHandle>();
        for (const target of targets) {
          committedHandles.set(
            target.targetId,
            replayed.archiveTransitionHandleV57(target.targetId),
          );
        }
        const ordered = releaseFirst === "first"
          ? targets
          : [targets[1], targets[0]] as const;
        const firstHandle = committedHandles.get(ordered[0].targetId);
        const secondHandle = committedHandles.get(ordered[1].targetId);
        if (firstHandle === undefined || secondHandle === undefined) {
          throw new Error("shared release handle disappeared");
        }
        journal.markTargetCommitted({
          targetId: ordered[0].targetId,
          commitEvidenceDigest: "4".repeat(64),
          commitRevisionDigest: "6".repeat(64),
          now: new Date("2026-07-19T13:15:00.000Z"),
        });
        const incompleteComponent = journal.terminalCleanupComponent(
          ordered[0].targetId,
        );
        expect(incompleteComponent).toEqual({
          accountProfileId: account.id,
          targetIds: targets.map(({ targetId }) => targetId),
          cutIds: [cutId],
          allTargetsCommitted: false,
        });
        for (const driftedComponent of [
          { ...incompleteComponent, accountProfileId: "acct_component_drift" },
          {
            ...incompleteComponent,
            targetIds: [...incompleteComponent.targetIds].reverse(),
          },
          { ...incompleteComponent, cutIds: [] },
          { ...incompleteComponent, allTargetsCommitted: true },
        ]) {
          expect(() => replayed!.releaseArchiveTransition(
            ordered[0].targetId,
            firstHandle,
            driftedComponent,
          )).toThrow("Provider archive terminal cleanup authority changed.");
        }
        expect(replayed.archiveTransitionHandleV57(ordered[0].targetId))
          .toBe(firstHandle);
        expect(replayed.archiveTransitionHandleV57(ordered[1].targetId))
          .toBe(secondHandle);
        expect(journal.reopenTarget(ordered[0].targetId).status)
          .toBe("committed");
        expect(journal.reopenTarget(ordered[1].targetId).status)
          .not.toBe("committed");
        expect(archiveAdmissionGate.isHeld(account.id)).toBeTrue();
        expect(replayed.releaseArchiveTransition(
          ordered[0].targetId,
          firstHandle,
          incompleteComponent,
        )).toEqual({ deletedTargetIds: [], deletedCutIds: [] });
        expect(() => replayed!.archiveTransitionHandleV57(ordered[0].targetId))
          .toThrow("The provider archive recovery authority is unavailable.");
        expect(replayed.archiveTransitionHandleV57(ordered[1].targetId))
          .toBe(secondHandle);
        expect(journal.reopenTarget(ordered[0].targetId).status)
          .toBe("committed");
        expect(journal.reopenTarget(ordered[1].targetId).status)
          .not.toBe("committed");
        expect(archiveAdmissionGate.isHeld(account.id)).toBeTrue();
        expect(replayed.releaseArchiveTransition(
          ordered[0].targetId,
          firstHandle,
          incompleteComponent,
        )).toEqual({ deletedTargetIds: [], deletedCutIds: [] });

        journal.markTargetCommitted({
          targetId: ordered[1].targetId,
          commitEvidenceDigest: "5".repeat(64),
          commitRevisionDigest: "7".repeat(64),
          now: new Date("2026-07-19T13:16:00.000Z"),
        });
        const completeComponent = journal.terminalCleanupComponent(
          ordered[1].targetId,
        );
        expect(completeComponent).toEqual({
          ...incompleteComponent,
          allTargetsCommitted: true,
        });
        database.exec(`
          CREATE TRIGGER fail_shared_archive_component_delete
          BEFORE DELETE ON chat_provider_thread_archive_targets_v57
          BEGIN SELECT RAISE(ABORT, 'fixture shared target delete failure'); END;
        `);
        expect(() => replayed!.releaseArchiveTransition(
          ordered[1].targetId,
          secondHandle,
          completeComponent,
        )).toThrow();
        expect(replayed.archiveTransitionHandleV57(ordered[1].targetId))
          .toBe(secondHandle);
        expect(journal.reopenTarget(ordered[0].targetId).status)
          .toBe("committed");
        expect(journal.reopenTarget(ordered[1].targetId).status)
          .toBe("committed");
        expect(archiveAdmissionGate.isHeld(account.id)).toBeTrue();
        database.exec("DROP TRIGGER fail_shared_archive_component_delete");
        expect(replayed.releaseArchiveTransition(
          ordered[1].targetId,
          secondHandle,
          completeComponent,
        )).toEqual({
          deletedTargetIds: completeComponent.targetIds,
          deletedCutIds: completeComponent.cutIds,
        });
        expect(archiveAdmissionGate.isHeld(account.id)).toBeFalse();
        expect(() => journal.reopenTarget(targets[0].targetId)).toThrow();
        expect(() => journal.reopenTarget(targets[1].targetId)).toThrow();
        expect(() => journal.reopenCut(cutId)).toThrow();
        expect(replayed.releaseArchiveTransition(
          ordered[1].targetId,
          secondHandle,
          completeComponent,
        )).toEqual({ deletedTargetIds: [], deletedCutIds: [] });
      } finally {
        database.exec(
          "DROP TRIGGER IF EXISTS fail_shared_archive_component_delete",
        );
        await replayed?.shutdown();
        await service.shutdown();
        database.close();
      }
    };

    await runOrder("first");
    await runOrder("second");
  });

  test("promotes an atomically persisted effect-started transition without a prepared authority", async () => {
    const {
      archiveAdmissionGate,
      database,
      providerThreadArchiveJournalV57: journal,
      service,
      store,
    } = await fixture();
    try {
      const account = accountResult(
        await service.execute({ type: "account.create", label: "Work" }),
      );
      store.updateAuthState(
        account.id,
        "signedIn",
        new Date("2026-07-19T12:00:00.000Z"),
      );
      const provisional = await service.beginArchiveTransitionProvisional({
        accountProfileId: account.id,
        paneId: "pane_atomiceffect01",
        purpose: "pane_archive",
        transitionId: "archtarget_atomiceffect01",
      });
      const descriptor = database.transaction(() => prepareArchiveTarget({
        database,
        journal,
        store,
        accountProfileId: account.id,
        paneId: "pane_atomiceffect01",
        targetId: "archtarget_atomiceffect01",
        attemptId: "archattempt_atomiceffect01",
        now: new Date("2026-07-19T12:01:00.000Z"),
        effectStarted: true,
      }))();
      expect(await rejection(
        service.abortArchiveTransitionProvisional(provisional.handle),
      )).toHaveProperty(
        "message",
        "A durable provider archive target cannot release its provisional quarantine.",
      );
      expect(() => service.promoteArchiveTransitionEffectStarted(
        provisional.handle,
        "archtarget_foreigneffect01",
      )).toThrow("The provider archive provisional authority is stale or foreign.");
      expect(archiveAdmissionGate.isHeld(account.id)).toBeTrue();
      const effectStarted = service.promoteArchiveTransitionEffectStarted(
        provisional.handle,
        descriptor.transitionId,
      );

      expect(service.archiveTransitionHandleV57(descriptor.transitionId))
        .toBe(effectStarted);
      expect(archiveAdmissionGate.require(effectStarted)).toEqual(descriptor);
      expect(archiveAdmissionGate.claimThreadArchiveEffect(effectStarted))
        .toBeDefined();
      archiveAdmissionGate.release(effectStarted);
      expect(archiveAdmissionGate.isHeld(account.id)).toBeFalse();
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("derives account-removal authority from the journal and cannot abort after cut commit", async () => {
    const {
      archiveAdmissionGate,
      database,
      providerThreadArchiveJournalV57: journal,
      service,
      store,
    } = await fixture();
    try {
      const account = accountResult(
        await service.execute({ type: "account.create", label: "Removal" }),
      );
      store.updateAuthState(
        account.id,
        "signedIn",
        new Date("2026-07-19T12:00:00.000Z"),
      );
      expect(await service.ensureSessionRuntime(account.id)).toEqual({ generation: 1 });
      const provisional = await service.retainAccountRemovalProvisional(
        account.id,
        "archcut_removalservice01",
        1,
      );
      const descriptor = prepareAccountRemovalCut({
        journal,
        store,
        accountProfileId: account.id,
        cutId: "archcut_removalservice01",
        now: new Date("2026-07-19T12:01:00.000Z"),
      });

      expect(() => service.abortAccountRemovalProvisional(provisional))
        .toThrow("A durable account-removal cut cannot release its provisional quarantine.");
      const removal = service.promoteAccountRemoval(
        provisional,
        descriptor.transitionId,
      );
      expect(archiveAdmissionGate.requireAccountRemoval(removal)).toEqual(
        descriptor,
      );
      expect(() => service.releaseAccountRemoval(descriptor.transitionId, removal))
        .toThrow("Account-removal admission remains held until its exact tombstone is durable.");
      archiveAdmissionGate.releaseAccountRemoval(removal);
      expect(archiveAdmissionGate.isHeld(account.id)).toBeFalse();
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("joins an exact generation fence to the durable N+1 profile and cut", async () => {
    const {
      archiveAdmissionGate,
      database,
      providerThreadArchiveJournalV57: journal,
      router,
      service,
      store,
    } = await fixture();
    const paneId = "pane_archivefence01";
    const targetId = "archtarget_archivefence01";
    const attemptId = "archattempt_archivefence01";
    const cutId = "archcut_archivefence01";
    try {
      const account = accountResult(
        await service.execute({ type: "account.create", label: "Work" }),
      );
      store.updateAuthState(
        account.id,
        "signedIn",
        new Date("2026-07-19T12:00:00.000Z"),
      );
      const panes = new ChatPaneStore(database);
      panes.create({
        paneId,
        repository: {
          id: `repo_${"7".repeat(26)}`,
          name: "Archive fence",
          workingDirectory: "/fixture/archive-fence",
        },
        accountProfileId: account.id,
        now: new Date("2026-07-19T12:01:00.000Z"),
      });
      database.query(`
        UPDATE chat_panes SET provider_account_profile_id = ?2,
          provider_thread_id = ?3, provider_restart_thread_id = ?4
        WHERE pane_id = ?1
      `).run(
        paneId,
        account.id,
        "thread_archivefence01",
        "restart_archivefence01",
      );

      const provisional = await service.beginArchiveTransitionProvisional({
        accountProfileId: account.id,
        paneId,
        purpose: "pane_archive",
        transitionId: targetId,
      });
      expect(provisional.generation).toBe(1);
      const sourceProfile = store.find(account.id);
      if (sourceProfile === null) throw new Error("fixture account disappeared");
      journal.prepareTarget({
        targetId,
        paneId,
        purpose: "pane_archive",
        paneRevision: 1,
        queueRevision: null,
        paneCasDigest: "1".repeat(64),
        queueCasDigest: null,
        accountProfileId: account.id,
        accountProfileRevision: sourceProfile.revision,
        threadId: "thread_archivefence01",
        restartThreadId: "restart_archivefence01",
        binding: { kind: "none" },
        attempt: {
          attemptId,
          generation: 1,
          accountProfileRevision: sourceProfile.revision,
          requestEvidenceDigest: "2".repeat(64),
          requestRevisionDigest: "3".repeat(64),
        },
        now: new Date("2026-07-19T12:02:00.000Z"),
      });
      const prepared = service.promoteArchiveTransition(
        provisional.handle,
        targetId,
      );
      journal.markEffectStarted({
        attemptId,
        effectEvidenceDigest: "4".repeat(64),
        effectRevisionDigest: "5".repeat(64),
        now: new Date("2026-07-19T12:03:00.000Z"),
      });
      const effectStarted = service.replaceArchiveTransition(
        prepared,
        targetId,
      );
      journal.createCut({
        cutId,
        accountProfileId: account.id,
        accountProfileRevision: sourceProfile.revision,
        sourceGeneration: 1,
        cause: "lost_response",
        initiatingAttemptId: attemptId,
        predecessorCutId: null,
        identityEvidenceDigest: "6".repeat(64),
        identityRevisionDigest: "7".repeat(64),
        now: new Date("2026-07-19T12:04:00.000Z"),
      });
      journal.bindAttemptToCut(attemptId, cutId);
      journal.recordAmbiguous({
        attemptId,
        ambiguityEvidenceDigest: "8".repeat(64),
        ambiguityRevisionDigest: "9".repeat(64),
        now: new Date("2026-07-19T12:05:00.000Z"),
      });
      const ambiguous = service.replaceArchiveTransition(
        effectStarted,
        targetId,
      );

      const fenceCallsBeforeWrongCut = router.fenceCalls.length;
      expect(await rejection(service.containArchiveTransitionGenerationV57({
        accountProfileId: account.id,
        transitionId: targetId,
        cutId: "archcut_wrongfence01",
        archiveHandle: ambiguous,
      }))).toBeInstanceOf(Error);
      expect(router.fenceCalls).toHaveLength(fenceCallsBeforeWrongCut);
      expect(store.find(account.id)?.processGeneration).toBe(1);

      database.query(`
        UPDATE account_profiles SET revision = revision + 1
        WHERE profile_id = ?1
      `).run(account.id);
      const fenceCallsBeforeRevisionDrift = router.fenceCalls.length;
      expect(await rejection(service.containArchiveTransitionGenerationV57({
        accountProfileId: account.id,
        transitionId: targetId,
        cutId,
        archiveHandle: ambiguous,
      }))).toMatchObject({ code: "conflict" });
      expect(router.fenceCalls).toHaveLength(fenceCallsBeforeRevisionDrift);
      database.query(`
        UPDATE account_profiles SET revision = ?2
        WHERE profile_id = ?1
      `).run(account.id, sourceProfile.revision);

      router.beforeFence = (fencedAccountProfileId, expectedGeneration) => {
        expect(fencedAccountProfileId).toBe(account.id);
        expect(expectedGeneration).toBe(1);
        database.query(`
          UPDATE account_profiles SET revision = revision + 1
          WHERE profile_id = ?1
        `).run(account.id);
      };
      expect(await rejection(service.containArchiveTransitionGenerationV57({
        accountProfileId: account.id,
        transitionId: targetId,
        cutId,
        archiveHandle: ambiguous,
      }))).toMatchObject({ code: "conflict" });
      expect(store.find(account.id)).toMatchObject({
        processGeneration: 1,
        revision: sourceProfile.revision + 1,
      });
      expect(journal.reopenCut(cutId).state).toBe("fence_started");
      expect(service.archiveTransitionHandleV57(targetId)).toBe(ambiguous);
      expect(archiveAdmissionGate.isHeld(account.id)).toBeTrue();
      router.beforeFence = null;
      database.query(`
        UPDATE account_profiles SET revision = ?2
        WHERE profile_id = ?1
      `).run(account.id, sourceProfile.revision);

      router.fenceFailure = new Error("fixture router fence failure");
      expect(await rejection(service.containArchiveTransitionGenerationV57({
        accountProfileId: account.id,
        transitionId: targetId,
        cutId,
        archiveHandle: ambiguous,
      }))).toEqual(router.fenceFailure);
      expect(store.find(account.id)?.processGeneration).toBe(1);
      expect(journal.reopenCut(cutId).state).toBe("fence_started");
      expect(service.archiveTransitionHandleV57(targetId)).toBe(ambiguous);
      router.fenceFailure = null;

      database.exec(`
        CREATE TRIGGER fail_archive_fence_commit
        BEFORE UPDATE OF state ON chat_provider_thread_archive_cuts_v57
        WHEN NEW.state = 'fenced'
        BEGIN SELECT RAISE(ABORT, 'fixture fence commit failure'); END;
      `);
      expect(await rejection(service.containArchiveTransitionGenerationV57({
        accountProfileId: account.id,
        transitionId: targetId,
        cutId,
        archiveHandle: ambiguous,
      }))).toBeInstanceOf(Error);
      expect(store.find(account.id)?.processGeneration).toBe(1);
      expect(journal.reopenCut(cutId).state).toBe("fence_started");
      expect(service.archiveTransitionHandleV57(targetId)).toBe(ambiguous);
      expect(archiveAdmissionGate.isHeld(account.id)).toBeTrue();

      database.exec("DROP TRIGGER fail_archive_fence_commit");
      const contained = await service.containArchiveTransitionGenerationV57({
        accountProfileId: account.id,
        transitionId: targetId,
        cutId,
        archiveHandle: ambiguous,
      });
      expect(contained.generation).toBe(2);
      expect(journal.reopenCut(cutId)).toMatchObject({
        state: "fenced",
        successorGeneration: 2,
        successorAccountProfileRevision: contained.accountProfileRevision,
      });
      expect(journal.admissionDescriptor(targetId).successorGeneration).toBe(2);
      expect(service.archiveTransitionHandleV57(targetId)).toBe(
        contained.archiveHandle,
      );
      const reservedRevision = store.find(account.id)?.revision;
      expect(await service.ensureArchiveRecoveryRuntime(
        account.id,
        contained.archiveHandle,
      )).toEqual({ generation: 2 });
      expect(store.find(account.id)).toMatchObject({
        processGeneration: 2,
        revision: reservedRevision,
      });
      expect(router.generation(account.id)).toBe(2);
      archiveAdmissionGate.release(contained.archiveHandle);
    } finally {
      database.exec("DROP TRIGGER IF EXISTS fail_archive_fence_commit");
      await service.shutdown();
      database.close();
    }
  });

  test("binds and advances every same-generation target before the external fence", async () => {
    const {
      archiveAdmissionGate,
      createService,
      database,
      providerThreadArchiveJournalV57: journal,
      router,
      service,
      store,
    } = await fixture();
    let replayed: AccountService | null = null;
    try {
      const account = accountResult(
        await service.execute({ type: "account.create", label: "Multi" }),
      );
      store.updateAuthState(
        account.id,
        "signedIn",
        new Date("2026-07-19T12:00:00.000Z"),
      );
      expect(await service.ensureSessionRuntime(account.id)).toEqual({ generation: 1 });
      const first = prepareArchiveTarget({
        database,
        journal,
        store,
        accountProfileId: account.id,
        paneId: "pane_multitarget01",
        targetId: "archtarget_multitarget01",
        attemptId: "archattempt_multitarget01",
        now: new Date("2026-07-19T12:01:00.000Z"),
        effectStarted: true,
      });
      const second = prepareArchiveTarget({
        database,
        journal,
        store,
        accountProfileId: account.id,
        paneId: "pane_multitarget02",
        targetId: "archtarget_multitarget02",
        attemptId: "archattempt_multitarget02",
        now: new Date("2026-07-19T12:02:00.000Z"),
        effectStarted: true,
      });
      const sourceProfile = store.find(account.id);
      if (sourceProfile === null) throw new Error("multi-target profile disappeared");
      const cutId = "archcut_multitarget01";
      expect(journal.createCut({
        cutId,
        accountProfileId: account.id,
        accountProfileRevision: sourceProfile.revision,
        sourceGeneration: 1,
        cause: "lost_response",
        initiatingAttemptId: "archattempt_multitarget01",
        predecessorCutId: null,
        identityEvidenceDigest: "6".repeat(64),
        identityRevisionDigest: "7".repeat(64),
        now: new Date("2026-07-19T12:03:00.000Z"),
      })).toMatchObject({ targetCount: 2 });
      journal.bindAttemptToCut("archattempt_multitarget01", cutId);
      journal.recordAmbiguous({
        attemptId: "archattempt_multitarget01",
        ambiguityEvidenceDigest: "8".repeat(64),
        ambiguityRevisionDigest: "9".repeat(64),
        now: new Date("2026-07-19T12:04:00.000Z"),
      });

      replayed = createService(false);
      replayed.installArchiveAdmissionReplayV57();
      const firstBefore = replayed.archiveTransitionHandleV57(first.transitionId);
      const secondBefore = replayed.archiveTransitionHandleV57(second.transitionId);
      expect(archiveAdmissionGate.require(secondBefore).cutAuthority).toBeNull();

      journal.bindAllAffectedTargets(cutId);
      journal.recordAmbiguous({
        attemptId: "archattempt_multitarget02",
        ambiguityEvidenceDigest: "a".repeat(64),
        ambiguityRevisionDigest: "b".repeat(64),
        now: new Date("2026-07-19T12:04:01.000Z"),
      });
      const firstHandle = replayed.refreshArchiveTransitionCutAuthoritiesV57({
        archiveHandle: firstBefore,
        cutId,
        transitionId: first.transitionId,
      });
      expect(firstHandle).toBe(firstBefore);
      const secondAmbiguous = replayed.archiveTransitionHandleV57(
        second.transitionId,
      );
      expect(secondAmbiguous).not.toBe(secondBefore);
      expect(archiveAdmissionGate.require(secondAmbiguous)).toMatchObject({
        attemptPhase: "ambiguous",
        successorGeneration: null,
      });

      const contained = await replayed.containArchiveTransitionGenerationV57({
        accountProfileId: account.id,
        transitionId: first.transitionId,
        cutId,
        archiveHandle: firstHandle,
      });
      expect(router.fenceCalls).toEqual([{
        accountProfileId: account.id,
        expectedGeneration: 1,
      }]);
      expect(journal.reopenTarget(second.transitionId).currentAttempt.cutId)
        .toBe(cutId);
      const secondAfter = replayed.archiveTransitionHandleV57(second.transitionId);
      expect(secondAfter).not.toBe(secondAmbiguous);
      const secondDescriptor = archiveAdmissionGate.require(secondAfter);
      expect(secondDescriptor.cutAuthority).not.toBeNull();
      expect(secondDescriptor.expectedGeneration).toBe(1);
      expect(secondDescriptor.successorGeneration).toBe(2);
      expect(secondDescriptor.transitionId).toBe(second.transitionId);
      expect(secondDescriptor).toEqual(
        journal.admissionDescriptor(second.transitionId),
      );
      expect(contained.generation).toBe(2);
    } finally {
      if (replayed !== null) await replayed.shutdown();
      await service.shutdown();
      database.close();
    }
  });

  test("cold boot launches only the exact journal-preclaimed successor without another profile bump", async () => {
    const prepared: { value?: ReturnType<typeof prepareFencedArchiveSuccessor> } = {};
    const fixtureResult = await generationRecoveryFixture({
      beforeReplay: ({ database, journal, store }) => {
        prepared.value = prepareFencedArchiveSuccessor({ database, journal, store });
      },
    });
    const {
      database,
      processes,
      service,
      store,
    } = fixtureResult;
    try {
      const recovery = prepared.value;
      if (recovery === undefined) throw new Error("recovery fixture was not prepared");
      const targetId = recovery.targetId;
      const handle = service.archiveTransitionHandleV57(targetId);
      const revisionBefore = store.find(recovery.accountProfileId)?.revision;

      expect(await service.ensureArchiveRecoveryRuntime(
        recovery.accountProfileId,
        handle,
      )).toEqual({ generation: 2 });
      expect(processes.map(({ generation }) => generation)).toEqual([2]);
      expect(store.find(recovery.accountProfileId)).toMatchObject({
        processGeneration: 2,
        revision: recovery.successorProfileRevision,
      });
      expect(store.find(recovery.accountProfileId)?.revision).toBe(revisionBefore);

      expect(await service.ensureArchiveRecoveryRuntime(
        recovery.accountProfileId,
        handle,
      )).toEqual({ generation: 2 });
      expect(processes).toHaveLength(1);
      expect(store.find(recovery.accountProfileId)?.revision).toBe(revisionBefore);
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("activates one crash-replayed contained successor before its atomic effect-started rebase", async () => {
    const prepared: {
      value?: ReturnType<typeof prepareContainedNotAppliedArchiveSuccessor>;
    } = {};
    const fixtureResult = await generationRecoveryFixture({
      beforeReplay: ({ database, journal, store }) => {
        prepared.value = prepareContainedNotAppliedArchiveSuccessor({
          database,
          journal,
          store,
        });
      },
    });
    const {
      archiveAdmissionGate,
      database,
      processes,
      providerThreadArchiveJournalV57: journal,
      service,
      store,
    } = fixtureResult;
    try {
      const recovery = prepared.value;
      if (recovery === undefined) throw new Error("activation fixture was not prepared");
      const replayed = service.archiveTransitionHandleV57(recovery.targetId);
      expect(() => archiveAdmissionGate.claimThreadArchiveEffect(replayed))
        .toThrow();

      const activated = await service.activateArchiveTransitionSuccessorV57({
        accountProfileId: recovery.accountProfileId,
        transitionId: recovery.targetId,
        archiveHandle: replayed,
      });
      expect(activated.generation).toBe(2);
      expect(activated.archiveHandle).not.toBe(replayed);
      expect(service.archiveTransitionHandleV57(recovery.targetId)).toBe(
        activated.archiveHandle,
      );
      expect(() => archiveAdmissionGate.require(replayed)).toThrow();
      expect(processes.map(({ generation }) => generation)).toEqual([2]);
      expect(store.find(recovery.accountProfileId)).toMatchObject({
        processGeneration: 2,
        revision: recovery.successorProfileRevision,
      });

      const successorAttemptId = "archattempt_coldrecovery02";
      journal.appendSuccessorAttempt({
        targetId: recovery.targetId,
        attemptId: successorAttemptId,
        generation: 2,
        accountProfileRevision: recovery.successorProfileRevision,
        requestEvidenceDigest: "6".repeat(64),
        requestRevisionDigest: "7".repeat(64),
        now: new Date("2026-07-29T11:12:00.000Z"),
      });
      journal.markEffectStarted({
        attemptId: successorAttemptId,
        effectEvidenceDigest: "8".repeat(64),
        effectRevisionDigest: "9".repeat(64),
        now: new Date("2026-07-29T11:12:00.000Z"),
      });
      const effectStarted = service.replaceArchiveTransition(
        activated.archiveHandle,
        recovery.targetId,
      );
      const claim = archiveAdmissionGate.claimThreadArchiveEffect(effectStarted);
      archiveAdmissionGate.beginThreadArchiveEffect(claim);
      expect(() => archiveAdmissionGate.claimThreadArchiveEffect(effectStarted))
        .toThrow();
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("keeps replay quarantine when the contained successor profile drifts during launch", async () => {
    const prepared: {
      value?: ReturnType<typeof prepareContainedNotAppliedArchiveSuccessor>;
    } = {};
    const fixtureResult = await generationRecoveryFixture({
      beforeReplay: ({ database, journal, store }) => {
        prepared.value = prepareContainedNotAppliedArchiveSuccessor({
          database,
          journal,
          store,
        });
      },
    });
    const {
      archiveAdmissionGate,
      database,
      processes,
      profileFileSystem,
      service,
    } = fixtureResult;
    try {
      const recovery = prepared.value;
      if (recovery === undefined) throw new Error("activation fixture was not prepared");
      const replayed = service.archiveTransitionHandleV57(recovery.targetId);
      profileFileSystem.beforeEnsure = (accountProfileId) => {
        database.query(`
          UPDATE account_profiles SET revision = revision + 1
          WHERE profile_id = ?1
        `).run(accountProfileId);
      };
      expect(await rejection(service.activateArchiveTransitionSuccessorV57({
        accountProfileId: recovery.accountProfileId,
        transitionId: recovery.targetId,
        archiveHandle: replayed,
      }))).toMatchObject({ code: "conflict" });
      expect(processes).toEqual([]);
      expect(service.archiveTransitionHandleV57(recovery.targetId)).toBe(replayed);
      expect(archiveAdmissionGate.isHeld(recovery.accountProfileId)).toBeTrue();
      expect(archiveAdmissionGate.require(replayed).attemptPhase)
        .toBe("reconciled_not_applied");
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("cold boot rejects successor revision drift during profile preparation before process creation", async () => {
    const prepared: { value?: ReturnType<typeof prepareFencedArchiveSuccessor> } = {};
    const fixtureResult = await generationRecoveryFixture({
      beforeReplay: ({ database, journal, store }) => {
        prepared.value = prepareFencedArchiveSuccessor({ database, journal, store });
      },
    });
    const {
      database,
      processes,
      profileFileSystem,
      service,
      store,
    } = fixtureResult;
    try {
      const recovery = prepared.value;
      if (recovery === undefined) throw new Error("recovery fixture was not prepared");
      profileFileSystem.beforeEnsure = (accountProfileId) => {
        expect(accountProfileId).toBe(recovery.accountProfileId);
        database.query(`
          UPDATE account_profiles SET revision = revision + 1
          WHERE profile_id = ?1
        `).run(accountProfileId);
      };
      const handle = service.archiveTransitionHandleV57(recovery.targetId);
      expect(await rejection(service.ensureArchiveRecoveryRuntime(
        recovery.accountProfileId,
        handle,
      ))).toMatchObject({ code: "conflict" });
      expect(processes).toEqual([]);
      expect(store.find(recovery.accountProfileId)).toMatchObject({
        processGeneration: 2,
        revision: recovery.successorProfileRevision + 1,
      });
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("cold boot rejects an incoherent successor profile before process creation", async () => {
    const prepared: { value?: ReturnType<typeof prepareFencedArchiveSuccessor> } = {};
    const fixtureResult = await generationRecoveryFixture({
      beforeReplay: ({ database, journal, store }) => {
        prepared.value = prepareFencedArchiveSuccessor({
          database,
          journal,
          store,
          corruptProfilePostimage: true,
        });
      },
    });
    const { database, processes, service, store } = fixtureResult;
    try {
      const recovery = prepared.value;
      if (recovery === undefined) throw new Error("recovery fixture was not prepared");
      const handle = service.archiveTransitionHandleV57(recovery.targetId);
      expect(await rejection(service.ensureArchiveRecoveryRuntime(
        recovery.accountProfileId,
        handle,
      ))).toMatchObject({ code: "conflict" });
      expect(processes).toEqual([]);
      expect(store.find(recovery.accountProfileId)).toMatchObject({
        processGeneration: 1,
        revision: recovery.sourceProfileRevision,
      });
    } finally {
      await service.shutdown();
      database.close();
    }
  });

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

      await service.containAmbiguousChatEffect(created.id, initialGeneration);
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
      const initialGeneration = router.generation(created.id);
      if (initialGeneration === null) throw new Error("fake runtime generation missing");

      const logout = service.execute({ type: "account.logout", accountProfileId: created.id });
      const containment = service.containAmbiguousChatEffect(
        created.id,
        initialGeneration,
      );
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
      const initialGeneration = router.generation(created.id);
      if (initialGeneration === null) throw new Error("fake runtime generation missing");
      const revision = store.find(created.id)?.revision;
      if (revision === undefined) throw new Error("fixture account disappeared");

      const removal = service.execute({
        type: "account.remove",
        accountProfileId: created.id,
        expectedRevision: revision,
      });
      const containment = service.containAmbiguousChatEffect(
        created.id,
        initialGeneration,
      );
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

  test("account removal retries containment after a lost pre-tombstone response", async () => {
    let containmentCalls = 0;
    let contained = false;
    let runtimeIsRunning: (accountProfileId: string) => boolean = () => true;
    const value = await fixture({
      containChatsBeforeRemoval: (accountProfileId) => {
        expect(runtimeIsRunning(accountProfileId)).toBeFalse();
        containmentCalls += 1;
        contained = true;
        return containmentCalls === 1
          ? Promise.reject(new Error("fixture crash after durable containment"))
          : Promise.resolve();
      },
    });
    const { createService, database, events, router, service, store } = value;
    runtimeIsRunning = (accountProfileId) => router.isRunning(accountProfileId);
    let reopened: AccountService | null = null;
    try {
      const created = accountResult(
        await service.execute({ type: "account.create", label: "Work" }),
      );
      const expectedRevision = store.find(created.id)?.revision;
      if (expectedRevision === undefined) throw new Error("fixture account disappeared");

      const interrupted = await rejection(service.execute({
        type: "account.remove",
        accountProfileId: created.id,
        expectedRevision,
      }));
      expect(interrupted).toMatchObject({
        code: "operation_failed",
        retryable: true,
        action: "retry",
      });
      expect(contained).toBeTrue();
      expect(containmentCalls).toBe(1);
      expect(store.find(created.id)).toMatchObject({
        id: created.id,
        revision: expectedRevision,
      });
      expect(events.some((event) => event.type === "account.removed")).toBeFalse();
      expect(router.isRunning(created.id)).toBeFalse();

      await service.shutdown();
      reopened = createService();
      expect(await reopened.initialize()).toEqual([
        expect.objectContaining({ id: created.id }),
      ]);
      expect(await reopened.execute({
        type: "account.remove",
        accountProfileId: created.id,
        expectedRevision,
      })).toEqual({ type: "accepted" });

      expect(containmentCalls).toBe(2);
      expect(store.find(created.id)).toBeNull();
      expect(events.findLast((event) => event.type === "account.removed")).toEqual({
        type: "account.removed",
        accountProfileId: created.id,
      });
    } finally {
      await reopened?.shutdown();
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
      await service.containAmbiguousChatEffect(created.id, initialGeneration);

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
      const containment = service.containAmbiguousChatEffect(
        created.id,
        initialGeneration,
      );
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

      const first = service.containAmbiguousChatEffect(
        created.id,
        initialGeneration,
      );
      const duplicate = service.containAmbiguousChatEffect(
        created.id,
        initialGeneration,
      );
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
      expect(await rejection(service.containAmbiguousChatEffect(
        created.id,
        initialGeneration,
      ))).toMatchObject({
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
      await service.containAmbiguousChatEffect(created.id, initialGeneration);
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
        announceFence();
        await fenceRelease;
      };
      const containment = service.containAmbiguousChatEffect(
        created.id,
        initialGeneration,
      );
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

  test("projects semantic weekly usage while retaining private routing detail", async () => {
    const { database, router, service, store } = await fixture();
    try {
      const created = accountResult(await service.execute({ type: "account.create", label: "Work" }));
      store.updateAuthState(created.id, "signedIn", new Date("2026-07-19T12:00:00.000Z"));

      const accounts = await service.refreshDispatchAccounts();

      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        id: created.id,
        authState: "signedIn",
        weeklyUsage: {
          remainingPercent: 90,
          resetsAt: "2027-01-15T08:00:00.000Z",
        },
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

  test("one shared archive hold closes every ordinary account admission path", async () => {
    const {
      archiveAdmissionGate,
      database,
      router,
      service,
      store,
    } = await fixture();
    try {
      const account = accountResult(
        await service.execute({ type: "account.create", label: "Work" }),
      );
      store.updateAuthState(
        account.id,
        "signedIn",
        new Date("2026-07-19T12:00:00.000Z"),
      );
      const started = await service.beginArchiveTransitionProvisional({
        accountProfileId: account.id,
        paneId: "pane_archive_gate_0001",
        purpose: "pane_archive",
        transitionId: "archive_transition_0001",
      });
      expect(started.generation).toBe(1);
      const input = {
        cursor: null,
        limit: 64,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["appServer"],
        archived: false,
      } satisfies PinnedCodexRequestInput<"threadList">;

      expect(await rejection(service.ensureSessionRuntime(account.id))).toMatchObject({
        code: "runtime_unavailable",
      });
      expect(await rejection(
        service.requestSession(account.id, "threadList", input),
      )).toMatchObject({ code: "runtime_unavailable" });
      expect(await rejection(service.execute({
        type: "runtime.restartAccount",
        accountProfileId: account.id,
      }))).toMatchObject({ code: "runtime_unavailable" });
      expect(service.dispatchAccounts()).toEqual([]);
      expect(router.requests.filter(({ key }) => key === "threadList")).toEqual([]);

      archiveAdmissionGate.abortProvisional(started.handle);
      expect(await service.ensureSessionRuntime(account.id)).toEqual({ generation: 1 });
      expect(service.dispatchAccounts()).toHaveLength(1);
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

  test("refreshes a persisted signed-in account's weekly usage after startup", async () => {
    const { database, events, service, store } = await fixture();
    try {
      const created = store.create("Connected", new Date("2026-07-19T11:00:00.000Z"));
      store.updateAuthState(created.id, "signedIn", new Date("2026-07-19T11:01:00.000Z"));

      expect((await service.initialize())[0]).toMatchObject({
        id: created.id,
        authState: "signedIn",
        weeklyUsage: null,
      });
      for (let attempts = 0; attempts < 200; attempts += 1) {
        const latest = events.findLast(
          (event): event is Extract<AccountEvent, { type: "account.upserted" }> =>
            event.type === "account.upserted" && event.account.id === created.id,
        );
        if (latest?.account.weeklyUsage?.remainingPercent === 90) break;
        await Bun.sleep(1);
      }
      expect(events.findLast(
        (event): event is Extract<AccountEvent, { type: "account.upserted" }> =>
          event.type === "account.upserted" && event.account.id === created.id,
      )?.account).toMatchObject({
        authState: "signedIn",
        weeklyUsage: {
          remainingPercent: 90,
          resetsAt: "2027-01-15T08:00:00.000Z",
        },
      });
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("never projects stale weekly usage after a provider sign-out", async () => {
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
        weeklyUsage: null,
      });
      expect(service.dispatchAccounts()).toEqual([]);
    } finally {
      await service.shutdown();
      database.close();
    }
  });

  test("keeps weekly usage beyond routing freshness and refreshes it at reset", async () => {
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
      )?.account.weeklyUsage).toEqual({
        remainingPercent: 90,
        resetsAt: "2027-01-15T08:00:00.000Z",
      });

      nowMs += dispatchBudgetFreshnessMs;
      expect(scheduler.runNext()).toBe(dispatchBudgetFreshnessMs);
      for (let attempts = 0; attempts < 100; attempts += 1) {
        if (scheduler.tasks.some(({ active }) => active)) break;
        await Bun.sleep(1);
      }
      expect(events.findLast(
        (event): event is Extract<AccountEvent, { type: "account.upserted" }> =>
          event.type === "account.upserted" && event.account.id === created.id,
      )?.account.weeklyUsage?.remainingPercent).toBe(90);

      nowMs = 1_800_000_000 * 1_000;
      expect(scheduler.runNext()).toBe(nowMs - Date.UTC(2026, 6, 19, 12, 2, 0));
      for (let attempts = 0; attempts < 100; attempts += 1) {
        const weeklyUsage = events.findLast(
          (event): event is Extract<AccountEvent, { type: "account.upserted" }> =>
            event.type === "account.upserted" && event.account.id === created.id,
        )?.account.weeklyUsage;
        if (weeklyUsage === null) break;
        await Bun.sleep(1);
      }
      expect(events.findLast(
        (event): event is Extract<AccountEvent, { type: "account.upserted" }> =>
          event.type === "account.upserted" && event.account.id === created.id,
      )?.account.weeklyUsage).toBeNull();
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
