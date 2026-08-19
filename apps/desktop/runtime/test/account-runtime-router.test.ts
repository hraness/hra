import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import type { AccountSummary } from "../../contracts/runtime";
import {
  CodexRequestExpiredError,
  HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256,
  acceptPinnedCodexDynamicToolProbeWitness,
} from "../src/codex";
import type {
  CodexNotification,
  CodexGenerationEndReason,
  PinnedCodexRequestInput,
  PinnedCodexRequestOutput,
  CodexRpcCallbacks,
  CodexRespondableServerRequest,
  CodexServerRequest,
  CodexServerResponse,
  PinnedCodexDynamicToolProtocolCapability,
  PinnedCodexDynamicToolRequest,
} from "../src/codex";
import { parseCodexNotification } from "../src/codex/pinned-codecs";
import {
  AccountRuntimeCapacityError,
  AccountRuntimeGenerationFloorMismatchError,
  AccountRuntimeNotQuiescentError,
  AccountRuntimePathMismatchError,
  AccountRuntimeRouter as ProductionAccountRuntimeRouter,
  AccountRuntimeStaleRequestError,
  type AccountRuntimeFaultReason,
  type AccountRuntimeProcess,
  type AccountRuntimeProcessProtocol,
  type AccountRuntimeProcessFactoryInput,
  type AccountRuntimeRequestKey,
  type AccountRuntimeRouterOptions,
} from "../src/accounts/runtime-router";
import {
  ArchiveAdmissionAuthorityError,
  ArchiveAdmissionGate,
  ArchiveAdmissionHeldError,
  type ArchiveAdmissionDescriptor,
  type ArchiveAdmissionHandle,
  archiveRestartThreadDigest,
} from "../src/accounts/archive-admission-gate";
import type { RuntimePaths } from "../src/runtime-paths";

const accountA = "acct_account_a" as AccountSummary["id"];
const accountB = "acct_account_b" as AccountSummary["id"];
const dynamicToolBinarySha256 = "a".repeat(64);

function launchOptions(
  initialGeneration = 0,
  beforeCreate: (generation: number) => void | Promise<void> = () => undefined,
) {
  return { beforeCreate, initialGeneration } as const;
}

function paths(account: string): RuntimePaths {
  return {
    codexBinary: "/runtime/codex",
    codexHome: `/profiles/${account}/codex-home`,
    gitBinary: "/runtime/git",
    gitRoot: "/runtime",
  };
}

async function dynamicToolCapability(
  accountProfileId: AccountSummary["id"],
  processGeneration: number,
): Promise<PinnedCodexDynamicToolProtocolCapability> {
  const nowMs = Date.now();
  const payload = {
    schemaVersion: 1 as const,
    kind: "oprte.codex.dynamic-tool.real-probe-witness" as const,
    source: "signed-in-real-app-server" as const,
    runId: "019fbd82-efa4-7542-af14-492556dcbcf7",
    startedAt: new Date(nowMs - 6 * 60 * 1_000).toISOString(),
    finishedAt: new Date(nowMs - 60 * 1_000).toISOString(),
    codexVersion: "0.144.6" as const,
    binarySha256: dynamicToolBinarySha256,
    processGeneration,
    registration: {
      initializeExperimentalApi: true as const,
      carrierMethod: "thread/start" as const,
      paramsField: "dynamicTools",
      namespace: "oprte" as const,
      tool: "rlm_run" as const,
      specSha256: HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256,
    },
    observations: {
      registrationAccepted: true as const,
      exactThreadAndTurnIdentity: true as const,
      successfulCompletion: true as const,
      failedCompletion: true as const,
      cancellationResolution: true as const,
      duplicateCallObserved: true as const,
      duplicateCallRejected: true as const,
      restartGenerationScoped: true as const,
    },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const evidenceObjectDigest = createHash("sha256").update(bytes).digest("hex");
  const witness = await acceptPinnedCodexDynamicToolProbeWitness(
    { ...payload, evidenceObjectDigest },
    { binarySha256: dynamicToolBinarySha256, processGeneration, nowMs },
    {
      readVerifiedProbeEvidence: ({ digest }) => Promise.resolve(
        digest === evidenceObjectDigest
          ? { digest: evidenceObjectDigest, bytes }
          : null,
      ),
    },
  );
  if (witness === null) throw new Error("dynamic tool fixture was not verified");
  return {
    witness,
    caller: { accountProfileId, accountGeneration: processGeneration },
    runtimeBinarySha256: dynamicToolBinarySha256,
  };
}

class FakeProcess implements AccountRuntimeProcess {
  readonly callbacks: CodexRpcCallbacks;
  readonly dynamicToolCapability: PinnedCodexDynamicToolProtocolCapability | null;
  readonly expired: CodexGenerationEndReason[] = [];
  readonly faulted: Promise<AccountRuntimeFaultReason>;
  readonly generation: number;
  readonly profileId: AccountSummary["id"];
  readonly requests: Array<Readonly<{ key: AccountRuntimeRequestKey; input: unknown }>> = [];
  readonly responses: Array<Readonly<{
    request: CodexRespondableServerRequest;
    response: CodexServerResponse;
  }>> = [];
  readonly #resolveFault: (reason: AccountRuntimeFaultReason) => void;
  #timeoutNextRequest = false;
  #archiveResponseGate: Promise<void> | null = null;
  #emitThreadArchivedOnNextArchive = false;
  #expireHook: ((reason: CodexGenerationEndReason) => void | Promise<void>) | null = null;
  #turnStartResponseGate: Promise<void> | null = null;

  readonly protocol: AccountRuntimeProcessProtocol = {
    request: <K extends AccountRuntimeRequestKey>(
      key: K,
      input: PinnedCodexRequestInput<K>,
    ): Promise<PinnedCodexRequestOutput<K>> => {
      this.requests.push({ key, input });
      if (this.#timeoutNextRequest) {
        this.#timeoutNextRequest = false;
        // Match the production ordering: make the exact generation terminal
        // before the caller can react to its ambiguous timeout.
        this.#resolveFault("protocol_fault");
        return Promise.reject(new CodexRequestExpiredError(
          this.generation,
          "ambiguousMutation",
          "timeout",
        ));
      }
      if (key === "accountRead") {
        return Promise.resolve(fakePinnedOutput<K>({
          account: {
            type: "chatgpt",
            email: `${this.profileId}-${String(this.generation)}@example.test`,
            planType: "pro",
          },
          requiresOpenaiAuth: true,
        }));
      }
      if (key === "accountRateLimitsRead") {
        return Promise.resolve(fakePinnedOutput<K>({
          rateLimits: rateLimit("default"),
          rateLimitsByLimitId: null,
          rateLimitResetCredits: null,
        }));
      }
      if (key === "accountLoginStart") {
        return Promise.resolve(fakePinnedOutput<K>({
          type: "chatgpt",
          loginId: "login-router-quiescence",
          authUrl: "https://auth.openai.com/router-quiescence",
        }));
      }
      if (key === "accountLoginCancel") {
        return Promise.resolve(fakePinnedOutput<K>({ status: "canceled" }));
      }
      if (key === "turnStart") {
        const gate = this.#turnStartResponseGate ?? Promise.resolve();
        this.#turnStartResponseGate = null;
        return gate.then(() => fakePinnedOutput<K>({
          turn: activeTurnFixture(),
        }));
      }
      if (key === "threadArchive") {
        const gate = this.#archiveResponseGate ?? Promise.resolve();
        this.#archiveResponseGate = null;
        return gate.then(async () => {
          if (this.#emitThreadArchivedOnNextArchive) {
            this.#emitThreadArchivedOnNextArchive = false;
            const archive = input as PinnedCodexRequestInput<"threadArchive">;
            await this.callbacks.onNotification?.({
              generation: this.generation,
              streamPosition: 2,
              method: "thread/archived",
              params: { threadId: archive.threadId },
            });
          }
          return fakePinnedOutput<K>(undefined);
        });
      }
      if (key === "threadList") {
        return Promise.resolve(fakePinnedOutput<K>({
          data: [],
          nextCursor: null,
          backwardsCursor: null,
        }));
      }
      throw new Error(`unexpected fake request key: ${key}`);
    },
    requestWithResponsePosition: async <K extends AccountRuntimeRequestKey>(
      key: K,
      input: PinnedCodexRequestInput<K>,
    ) => ({
      generation: this.generation,
      output: await this.protocol.request(key, input),
      streamPosition: 1,
    }),
    respond: (
      request: CodexRespondableServerRequest,
      response: CodexServerResponse,
    ): Promise<void> => {
      this.responses.push({ request, response });
      return Promise.resolve();
    },
  };

  constructor(input: AccountRuntimeProcessFactoryInput) {
    this.callbacks = input.callbacks;
    this.dynamicToolCapability = input.dynamicToolCapability;
    this.generation = input.generation;
    this.profileId = input.accountProfileId;
    let resolveFault: (reason: AccountRuntimeFaultReason) => void = () => undefined;
    this.faulted = new Promise((resolve) => {
      resolveFault = resolve;
    });
    this.#resolveFault = resolveFault;
  }

  expire(reason: CodexGenerationEndReason): void | Promise<void> {
    this.expired.push(reason);
    return this.#expireHook?.(reason);
  }

  fault(reason: AccountRuntimeFaultReason): void {
    this.#resolveFault(reason);
  }

  timeoutNextRequest(): void {
    this.#timeoutNextRequest = true;
  }

  delayNextTurnStartResponse(gate: Promise<void>): void {
    this.#turnStartResponseGate = gate;
  }

  delayNextArchiveResponse(gate: Promise<void>): void {
    this.#archiveResponseGate = gate;
  }

  emitThreadArchivedOnNextArchive(): void {
    this.#emitThreadArchivedOnNextArchive = true;
  }

  onExpire(
    hook: (reason: CodexGenerationEndReason) => void | Promise<void>,
  ): void {
    this.#expireHook = hook;
  }
}

function fakePinnedOutput<K extends AccountRuntimeRequestKey>(
  value: unknown,
): PinnedCodexRequestOutput<K> {
  return value as PinnedCodexRequestOutput<K>;
}

function activeTurnFixture() {
  return {
    id: "turn-response-active",
    items: [],
    itemsView: "full" as const,
    status: "inProgress" as const,
    startedAt: 1,
    completedAt: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function rateLimit(id: string) {
  return {
    limitId: id,
    limitName: id,
    primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: null },
    secondary: null,
    credits: null,
    individualLimit: null,
    planType: "pro",
    rateLimitReachedType: null,
  } as const;
}

function archiveDescriptor(
  suffix: string,
  overrides: Partial<ArchiveAdmissionDescriptor> = {},
): ArchiveAdmissionDescriptor {
  return {
    accountProfileId: accountA,
    attemptAuthority: { hmac: "b".repeat(64), revision: 4 },
    attemptOrdinal: 1,
    attemptPhase: "prepared",
    cutAuthority: null,
    expectedGeneration: 1,
    paneId: `pane-${suffix}`,
    purpose: "pane_archive",
    restartThreadDigest: archiveRestartThreadDigest(`thread-${suffix}`),
    successorGeneration: null,
    targetAuthority: { hmac: "a".repeat(64), revision: 3 },
    transitionId: `transition-${suffix}`,
    ...overrides,
  };
}

type TestAccountRuntimeRouterOptions =
  & Omit<AccountRuntimeRouterOptions, "archiveAdmissionGate">
  & { readonly archiveAdmissionGate?: ArchiveAdmissionGate };

class AccountRuntimeRouter extends ProductionAccountRuntimeRouter {
  constructor(options: TestAccountRuntimeRouterOptions = {}) {
    super({
      ...options,
      archiveAdmissionGate: options.archiveAdmissionGate ??
        new ArchiveAdmissionGate(),
    });
  }
}

function fakeRouter(
  callbackProfiles: AccountSummary["id"][] = [],
): Readonly<{
  created: FakeProcess[];
  router: AccountRuntimeRouter;
}> {
  const created: FakeProcess[] = [];
  const router = new AccountRuntimeRouter({
    callbacks: {
      onNotification(profileId) {
        callbackProfiles.push(profileId);
      },
    },
    createProcess(input) {
      const process = new FakeProcess(input);
      created.push(process);
      return Promise.resolve(process);
    },
    policy: {
      initialDelayMs: 1,
      maximumDelayMs: 1,
      maximumRestartAttempts: 4,
    },
    sleep: () => Promise.resolve(),
  });
  return { created, router };
}

function requireCreatedProcess(
  created: readonly FakeProcess[],
  index: number,
): FakeProcess {
  const process = created[index];
  if (process === undefined) throw new Error("missing fake process");
  return process;
}

async function waitForGeneration(
  router: AccountRuntimeRouter,
  profileId: AccountSummary["id"],
  generation: number,
): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (router.generation(profileId) === generation && router.isRunning(profileId)) return;
    await Bun.sleep(0);
  }
  throw new Error("account runtime did not reach the expected generation");
}

async function waitForShutdown(shutdown: Promise<void> | null): Promise<void> {
  if (shutdown === null) throw new Error("shutdown race did not start");
  await shutdown;
}

describe("AccountRuntimeRouter", () => {
  test("requires the one shared archive admission gate in production", () => {
    type GateIsRequired = AccountRuntimeRouterOptions extends {
      readonly archiveAdmissionGate: ArchiveAdmissionGate;
    } ? true : false;
    const gateIsRequired: GateIsRequired = true;

    expect(gateIsRequired).toBeTrue();
    expect(() => {
      Reflect.construct(
        ProductionAccountRuntimeRouter,
        [Object.freeze({})],
      );
    }).toThrow("requires one shared archive admission gate");
  });

  test("keeps fifty configured subscriptions within the default 32-runtime FD budget", async () => {
    const created: FakeProcess[] = [];
    const router = new AccountRuntimeRouter({
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
    });
    const accounts: AccountSummary["id"][] = Array.from(
      { length: 50 },
      (_, index) => `acct_capacity_${String(index + 1).padStart(2, "0")}`,
    );

    for (const [index, account] of accounts.entries()) {
      await router.ensure(account, paths(`capacity-${String(index + 1)}`), launchOptions());
    }

    expect(created).toHaveLength(50);
    expect(created.slice(0, 18).every((process) =>
      process.expired.join() === "stopped"
    )).toBeTrue();
    expect(created.slice(18).every((process) => process.expired.length === 0)).toBeTrue();
    expect(accounts.filter((account) => router.isRunning(account))).toEqual(
      accounts.slice(18),
    );
  });

  test("evicts only the least-recently-used proven-idle runtime at the FD budget", async () => {
    const created: FakeProcess[] = [];
    const stopped: Array<Readonly<{ accountProfileId: string; cause: string }>> = [];
    const router = new AccountRuntimeRouter({
      callbacks: {
        onState(accountProfileId, state, cause) {
          if (state.type === "stopped") stopped.push({ accountProfileId, cause });
        },
      },
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
      maximumLiveProcesses: 2,
    });

    await router.ensure(accountA, paths("a"), launchOptions());
    const firstA = requireCreatedProcess(created, 0);
    await router.ensure(accountB, paths("b"), launchOptions());
    const firstB = requireCreatedProcess(created, 1);
    const accountC = "acct_account_c" as AccountSummary["id"];
    await router.ensure(accountC, paths("c"), launchOptions());
    const processC = requireCreatedProcess(created, 2);

    expect(created[0]).toBe(firstA);
    expect(created[1]).toBe(firstB);
    expect(created[2]).toBe(processC);
    expect(created.map(({ profileId }) => profileId)).toEqual([
      accountA,
      accountB,
      accountC,
    ]);
    expect(created[0]?.expired).toEqual(["stopped"]);
    expect(created[1]?.expired).toEqual([]);
    expect(router.isRunning(accountA)).toBeFalse();
    expect(router.isRunning(accountB)).toBeTrue();
    expect(router.isRunning(accountC)).toBeTrue();
    expect(stopped).toEqual([{
      accountProfileId: accountA,
      cause: "capacity_evicted",
    }]);
  });

  test("an exact fence joins capacity eviction without a duplicate stop", async () => {
    const created: FakeProcess[] = [];
    const stopped: Array<Readonly<{ accountProfileId: string; cause: string }>> = [];
    const router = new AccountRuntimeRouter({
      callbacks: {
        onState(accountProfileId, state, cause) {
          if (state.type === "stopped") stopped.push({ accountProfileId, cause });
        },
      },
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
      maximumLiveProcesses: 1,
    });
    await router.ensure(accountA, paths("capacity-fence-a"), launchOptions());
    const first = requireCreatedProcess(created, 0);

    const admitted = router.ensure(accountB, paths("capacity-fence-b"), launchOptions());
    const fenced = router.fenceGeneration(accountA, first.generation);
    expect(await fenced).toBe("fenced");
    await admitted;
    requireCreatedProcess(created, 1);

    expect(first.expired).toEqual(["stopped"]);
    expect(created.map(({ profileId }) => profileId)).toEqual([accountA, accountB]);
    expect(stopped).toEqual([{
      accountProfileId: accountA,
      cause: "explicit_stop",
    }]);
  });

  test("queues account admission while every live runtime owns active work", async () => {
    const created: FakeProcess[] = [];
    const accountC = "acct_account_c" as AccountSummary["id"];
    const router = new AccountRuntimeRouter({
      admissionTimeoutMs: 2_000,
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
      maximumLiveProcesses: 1,
    });
    await router.ensure(accountA, paths("a"), launchOptions());
    const processA = requireCreatedProcess(created, 0);
    await processA.callbacks.onNotification?.(turnLifecycleNotification(
      "turn/started",
      processA.generation,
      "thread-active-a",
      "turn-active-a",
    ));

    let secondSettled = false;
    const second = router.ensure(accountB, paths("b"), launchOptions())
      .finally(() => { secondSettled = true; });
    const third = router.ensure(accountC, paths("c"), launchOptions());
    await Bun.sleep(10);
    expect(secondSettled).toBeFalse();
    expect(created).toHaveLength(1);

    await processA.callbacks.onNotification?.(turnLifecycleNotification(
      "turn/completed",
      processA.generation,
      "thread-active-a",
      "turn-active-a",
    ));
    await Promise.all([second, third]);
    const processB = requireCreatedProcess(created, 1);
    const processC = requireCreatedProcess(created, 2);

    expect(processB.profileId).toBe(accountB);
    expect(processC.profileId).toBe(accountC);
    expect(created.map(({ profileId }) => profileId)).toEqual([
      accountA,
      accountB,
      accountC,
    ]);
    expect(created[0]?.expired).toEqual(["stopped"]);
    expect(created[1]?.expired).toEqual(["stopped"]);
    expect(router.isRunning(accountC)).toBeTrue();
  });

  test("pins a turn returned before its lifecycle notification until exact completion", async () => {
    const created: FakeProcess[] = [];
    const router = new AccountRuntimeRouter({
      admissionTimeoutMs: 2_000,
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
      maximumLiveProcesses: 1,
    });
    await router.ensure(accountA, paths("a"), launchOptions());
    const processA = requireCreatedProcess(created, 0);
    await router.request(accountA, "turnStart", {
      threadId: "thread-response-active",
      clientUserMessageId: "message-response-active",
      input: [{ type: "text", text: "Hold this runtime", text_elements: [] }],
    });

    let admitted = false;
    const second = router.ensure(accountB, paths("b"), launchOptions())
      .then((process) => {
        admitted = true;
        return process;
      });
    await Bun.sleep(10);
    expect(admitted).toBeFalse();
    expect(created).toHaveLength(1);

    await processA.callbacks.onNotification?.(turnLifecycleNotification(
      "turn/completed",
      processA.generation,
      "thread-response-active",
      "turn-response-active",
    ));
    await second;
    const processB = requireCreatedProcess(created, 1);
    expect(processB.profileId).toBe(accountB);
    expect(created).toHaveLength(2);
  });

  test("a completion notification before the turn response prevents stale re-pinning", async () => {
    const created: FakeProcess[] = [];
    const router = new AccountRuntimeRouter({
      admissionTimeoutMs: 2_000,
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
      maximumLiveProcesses: 1,
    });
    await router.ensure(accountA, paths("a"), launchOptions());
    const processA = requireCreatedProcess(created, 0);
    const responseGate = deferred<void>();
    processA.delayNextTurnStartResponse(responseGate.promise);
    const start = router.request(accountA, "turnStart", {
      threadId: "thread-response-active",
      clientUserMessageId: "message-response-race",
      input: [{ type: "text", text: "Complete before response", text_elements: [] }],
    });
    await processA.callbacks.onNotification?.(turnLifecycleNotification(
      "turn/completed",
      processA.generation,
      "thread-response-active",
      "turn-response-active",
    ));
    responseGate.resolve();
    await start;

    await router.ensure(accountB, paths("b"), launchOptions());
    const processB = requireCreatedProcess(created, 1);
    expect(processB.profileId).toBe(accountB);
    expect(created).toHaveLength(2);
    expect(created[0]?.expired).toEqual(["stopped"]);
  });

  test("times out bounded admission without launching or advancing a queued runtime", async () => {
    const created: FakeProcess[] = [];
    const router = new AccountRuntimeRouter({
      admissionTimeoutMs: 25,
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
      maximumLiveProcesses: 1,
    });
    await router.ensure(accountA, paths("a"), launchOptions());
    const processA = requireCreatedProcess(created, 0);
    await processA.callbacks.onNotification?.(turnLifecycleNotification(
      "turn/started",
      processA.generation,
      "thread-active-timeout",
      "turn-active-timeout",
    ));

    const [result] = await Promise.allSettled([
      router.ensure(accountB, paths("b"), launchOptions(7)),
    ]);

    expect(result?.status).toBe("rejected");
    if (result?.status !== "rejected") throw new Error("capacity wait unexpectedly resolved");
    expect(result.reason).toBeInstanceOf(AccountRuntimeCapacityError);
    expect(created).toHaveLength(1);
    expect(router.generation(accountB)).toBe(7);
    expect(router.isRunning(accountA)).toBeTrue();
  });

  test("does not evict a runtime until its exact server request is settled", async () => {
    const created: FakeProcess[] = [];
    const router = new AccountRuntimeRouter({
      admissionTimeoutMs: 2_000,
      callbacks: { onServerRequest: () => undefined },
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
      maximumLiveProcesses: 1,
    });
    await router.ensure(accountA, paths("a"), launchOptions());
    const processA = requireCreatedProcess(created, 0);
    const request: CodexServerRequest = {
      generation: processA.generation,
      id: 71,
      requestInstanceId: 1,
      streamPosition: 1,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-capacity-request",
        turnId: "turn-capacity-request",
        itemId: "item-capacity-request",
        startedAtMs: 1,
      },
    };
    await processA.callbacks.onServerRequest?.(request);

    let admitted = false;
    const second = router.ensure(accountB, paths("b"), launchOptions())
      .then((process) => {
        admitted = true;
        return process;
      });
    await Bun.sleep(10);
    expect(admitted).toBeFalse();
    expect(created).toHaveLength(1);

    await router.respond(accountA, request, {
      type: "error",
      code: -32_600,
      message: "Unsupported",
    });
    await second;
    const processB = requireCreatedProcess(created, 1);
    expect(processB.profileId).toBe(accountB);
    expect(created).toHaveLength(2);
    expect(created[0]?.expired).toEqual(["stopped"]);
  });

  test("starts lazily and isolates concurrent requests and events by account", async () => {
    const callbackProfiles: AccountSummary["id"][] = [];
    const { created, router } = fakeRouter(callbackProfiles);

    expect(router.isRunning(accountA)).toBeFalse();
    expect(router.configuredAccountProfileIds()).toEqual([]);
    expect(created).toHaveLength(0);
    const [processA, processB] = await Promise.all([
      router.ensure(accountA, paths("a"), launchOptions()),
      router.ensure(accountB, paths("b"), launchOptions()),
    ]);
    expect(created).toHaveLength(2);
    expect(router.configuredAccountProfileIds()).toEqual([accountA, accountB]);
    expect(Object.isFrozen(router.configuredAccountProfileIds())).toBeTrue();
    expect(processA).not.toBe(processB);
    expect(created.map(({ dynamicToolCapability }) => dynamicToolCapability))
      .toEqual([null, null]);
    expect(router.supportsDynamicTool(accountA)).toBeFalse();
    expect(router.supportsDynamicTool(accountB, 1)).toBeFalse();

    const [responseA, responseB] = await Promise.all([
      router.request(accountA, "accountRead", { refreshToken: false }),
      router.request(accountB, "accountRateLimitsRead", undefined),
    ]);
    expect(responseA).toMatchObject({
      account: { email: `${accountA}-1@example.test` },
    });
    expect(responseB).toMatchObject({
      rateLimits: { limitId: "default" },
    });
    expect(created[0]?.requests).toEqual([
      { key: "accountRead", input: { refreshToken: false } },
    ]);
    expect(created[1]?.requests).toEqual([
      { key: "accountRateLimitsRead", input: undefined },
    ]);

    await created[0]?.callbacks.onNotification?.({
      generation: 1,
      streamPosition: 1,
      method: "account/updated",
      params: { authMode: "chatgpt", planType: "pro" },
    });
    await created[1]?.callbacks.onNotification?.({
      generation: 1,
      streamPosition: 1,
      method: "account/rateLimits/updated",
      params: { rateLimits: {} },
    });
    expect(callbackProfiles).toEqual([accountA, accountB]);
  });

  test("resolves dynamic-tool authority for one exact account generation", async () => {
    const created: FakeProcess[] = [];
    const resolutions: Array<Readonly<{
      accountProfileId: AccountSummary["id"];
      generation: number;
    }>> = [];
    const dynamicRequests: Array<Readonly<{
      accountProfileId: AccountSummary["id"];
      generation: number;
    }>> = [];
    const router = new AccountRuntimeRouter({
      callbacks: {
        onDynamicToolRequest(accountProfileId, request) {
          dynamicRequests.push({ accountProfileId, generation: request.generation });
        },
      },
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
      dynamicToolCapability: async (input) => {
        resolutions.push({
          accountProfileId: input.accountProfileId,
          generation: input.generation,
        });
        return await dynamicToolCapability(
          input.accountProfileId,
          input.generation,
        );
      },
      policy: {
        initialDelayMs: 1,
        maximumDelayMs: 1,
        maximumRestartAttempts: 2,
      },
      sleep: () => Promise.resolve(),
    });

    await router.ensure(accountA, paths("a"), launchOptions(3));
    const first = created[0];
    if (first === undefined) throw new Error("missing first dynamic process");
    expect(first.dynamicToolCapability).toMatchObject({
      caller: { accountProfileId: accountA, accountGeneration: 4 },
      witness: { processGeneration: 4 },
    });
    expect(router.supportsDynamicTool(accountA)).toBeTrue();
    expect(router.supportsDynamicTool(accountA, 4)).toBeTrue();
    expect(router.supportsDynamicTool(accountA, 3)).toBeFalse();
    expect(router.readDynamicToolCapability(accountA, 4)).toBe(
      first.dynamicToolCapability,
    );
    expect(router.readDynamicToolCapability(accountA, 3)).toBeNull();
    const request: PinnedCodexDynamicToolRequest = {
      method: "item/tool/call",
      params: {
        threadId: "thread-dynamic",
        turnId: "turn-dynamic",
        callId: "call-dynamic",
        namespace: "oprte",
        tool: "rlm_run",
        arguments: { schemaVersion: 1, action: "submit", program: {} },
        argumentsSha256: "b".repeat(64),
      },
      generation: 4,
      id: "dynamic-request",
      requestInstanceId: 1,
      streamPosition: 1,
      accountProfileId: accountA,
      accountGeneration: 4,
    };
    await first.callbacks.onDynamicToolRequest?.(request);
    expect(dynamicRequests).toEqual([{ accountProfileId: accountA, generation: 4 }]);
    await router.respond(accountA, request, {
      type: "result",
      result: { contentItems: [], success: true },
    });
    expect(first.responses).toEqual([{
      request,
      response: { type: "result", result: { contentItems: [], success: true } },
    }]);

    await router.restart(accountA);
    expect(created[1]?.dynamicToolCapability).toMatchObject({
      caller: { accountProfileId: accountA, accountGeneration: 5 },
      witness: { processGeneration: 5 },
    });
    expect(router.supportsDynamicTool(accountA, 4)).toBeFalse();
    expect(router.supportsDynamicTool(accountA, 5)).toBeTrue();
    expect(router.readDynamicToolCapability(accountA, 4)).toBeNull();
    expect(router.readDynamicToolCapability(accountA, 5)).toBe(
      created[1]!.dynamicToolCapability,
    );
    expect(resolutions).toEqual([
      { accountProfileId: accountA, generation: 4 },
      { accountProfileId: accountA, generation: 5 },
    ]);
  });

  test("drops mismatched or unavailable dynamic-tool authority without blocking startup", async () => {
    const mismatchedCreated: FakeProcess[] = [];
    const mismatched = new AccountRuntimeRouter({
      callbacks: { onDynamicToolRequest: () => undefined },
      createProcess(input) {
        const process = new FakeProcess(input);
        mismatchedCreated.push(process);
        return Promise.resolve(process);
      },
      dynamicToolCapability: async ({ generation }) =>
        await dynamicToolCapability(accountB, generation),
    });
    await mismatched.ensure(accountA, paths("a"), launchOptions());
    expect(mismatchedCreated[0]?.dynamicToolCapability).toBeNull();
    expect(mismatched.supportsDynamicTool(accountA, 1)).toBeFalse();
    expect(mismatched.readDynamicToolCapability(accountA, 1)).toBeNull();

    const unavailableCreated: FakeProcess[] = [];
    const unavailable = new AccountRuntimeRouter({
      callbacks: { onDynamicToolRequest: () => undefined },
      createProcess(input) {
        const process = new FakeProcess(input);
        unavailableCreated.push(process);
        return Promise.resolve(process);
      },
      dynamicToolCapability: () => {
        throw new Error("private custody detail");
      },
    });
    await unavailable.ensure(accountA, paths("a"), launchOptions());
    expect(unavailableCreated[0]?.dynamicToolCapability).toBeNull();
    expect(unavailable.supportsDynamicTool(accountA)).toBeFalse();
    expect(unavailable.readDynamicToolCapability(accountA, 1)).toBeNull();
  });

  test("never resolves or advertises dynamic-tool authority without a response owner", async () => {
    const created: FakeProcess[] = [];
    let resolutions = 0;
    const router = new AccountRuntimeRouter({
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
      dynamicToolCapability: async ({ accountProfileId, generation }) => {
        resolutions += 1;
        return await dynamicToolCapability(accountProfileId, generation);
      },
    });

    await router.ensure(accountA, paths("a"), launchOptions());

    expect(resolutions).toBe(0);
    expect(created[0]?.dynamicToolCapability).toBeNull();
    expect(created[0]?.callbacks.onDynamicToolRequest).toBeUndefined();
    expect(router.supportsDynamicTool(accountA, 1)).toBeFalse();
  });

  test("preserves the response position through account routing", async () => {
    const { created, router } = fakeRouter();
    await router.ensure(accountA, paths("a"), launchOptions(7));

    const response = await router.requestWithResponsePosition(
      accountA,
      "accountRead",
      { refreshToken: false },
      8,
    );

    expect(response).toEqual({
      generation: 8,
      output: {
        account: {
          type: "chatgpt",
          email: `${accountA}-8@example.test`,
          planType: "pro",
        },
        requiresOpenaiAuth: true,
      },
      streamPosition: 1,
    });
    expect(created[0]?.requests).toEqual([
      { key: "accountRead", input: { refreshToken: false } },
    ]);
  });

  test("coalesces starts and refuses to rebind a profile to another credential home", async () => {
    const { created, router } = fakeRouter();
    const [first, second] = await Promise.all([
      router.ensure(accountA, paths("a"), launchOptions()),
      router.ensure(accountA, paths("a"), launchOptions()),
    ]);
    expect(first).toEqual(second);
    expect("protocol" in first).toBeFalse();
    expect(created).toHaveLength(1);
    const [mismatch] = await Promise.allSettled([
      router.ensure(accountA, paths("b"), launchOptions()),
    ]);
    expect(mismatch?.status).toBe("rejected");
    if (mismatch?.status !== "rejected") throw new Error("expected path mismatch");
    expect(mismatch.reason).toBeInstanceOf(AccountRuntimePathMismatchError);
  });

  test("persists seeded generations before launch and retries a rejected gate without reuse", async () => {
    const created: FakeProcess[] = [];
    const order: string[] = [];
    let rejectGate = true;
    const router = new AccountRuntimeRouter({
      createProcess(input) {
        order.push(`create:${String(input.generation)}`);
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
      callbacks: {
        onState(_profileId, state) {
          if (state.type === "starting") {
            order.push(`starting:${String(state.generation)}`);
          }
        },
      },
      policy: {
        initialDelayMs: 1,
        maximumDelayMs: 1,
        maximumRestartAttempts: 4,
      },
      sleep: () => Promise.resolve(),
    });
    const options = launchOptions(12, async (generation) => {
      order.push(`persist:${String(generation)}`);
      await Promise.resolve();
      if (rejectGate) {
        rejectGate = false;
        throw new Error("fixture persistence failure");
      }
    });

    const [recovered] = await Promise.allSettled([
      router.ensure(accountA, paths("a"), options),
    ]);
    expect(recovered?.status).toBe("fulfilled");
    if (recovered?.status !== "fulfilled") throw recovered?.reason;
    expect(recovered.value.generation).toBe(14);
    expect(router.generation(accountA)).toBe(14);
    expect(router.isRunning(accountA)).toBeTrue();
    expect(created.map(({ generation }) => generation)).toEqual([14]);
    expect(order).toEqual(["persist:13", "persist:14", "starting:14", "create:14"]);
    expect((await router.ensure(accountA, paths("a"), options)).generation).toBe(14);
    expect(order).toEqual(["persist:13", "persist:14", "starting:14", "create:14"]);
    expect((await router.restart(accountA))?.generation).toBe(15);
    expect(order.slice(-3)).toEqual(["persist:15", "starting:15", "create:15"]);

    const [newerFloor] = await Promise.allSettled([
      router.ensure(accountA, paths("a"), launchOptions(16)),
    ]);
    expect(newerFloor?.status).toBe("rejected");
    if (newerFloor?.status !== "rejected") throw new Error("expected floor mismatch");
    expect(newerFloor.reason).toBeInstanceOf(
      AccountRuntimeGenerationFloorMismatchError,
    );
  });

  test("restarts and filters stale callbacks by profile and generation", async () => {
    const callbackProfiles: AccountSummary["id"][] = [];
    const { created, router } = fakeRouter(callbackProfiles);
    await Promise.all([
      router.ensure(accountA, paths("a"), launchOptions()),
      router.ensure(accountB, paths("b"), launchOptions()),
    ]);
    const firstA = created.find(
      ({ profileId, generation }) => profileId === accountA && generation === 1,
    );
    const firstB = created.find(
      ({ profileId, generation }) => profileId === accountB && generation === 1,
    );
    if (firstA === undefined || firstB === undefined) throw new Error("missing fake generations");

    const replacementA = await router.restart(accountA);
    expect(replacementA?.generation).toBe(2);
    expect(firstA.expired).toEqual(["restart_requested"]);
    expect(firstB.expired).toEqual([]);
    expect(router.generation(accountB)).toBe(1);

    await firstA.callbacks.onNotification?.({
      generation: 1,
      streamPosition: 1,
      method: "account/updated",
      params: { authMode: null, planType: null },
    });
    const secondA = created.find(
      ({ profileId, generation }) => profileId === accountA && generation === 2,
    );
    if (secondA === undefined) throw new Error("missing replacement generation");
    await secondA.callbacks.onNotification?.({
      generation: 2,
      streamPosition: 1,
      method: "account/updated",
      params: { authMode: null, planType: null },
    });
    expect(callbackProfiles).toEqual([accountA]);

    firstA.fault("process_exited");
    await Bun.sleep(0);
    expect(router.generation(accountA)).toBe(2);
    firstB.fault("protocol_fault");
    await waitForGeneration(router, accountB, 2);
    expect(router.generation(accountA)).toBe(2);
    expect(firstB.expired).toEqual(["protocol_fault"]);
  });

  test("routes the request after an ambiguous timeout only through a fresh generation", async () => {
    const { created, router } = fakeRouter();
    await router.ensure(accountA, paths("a"), launchOptions());
    const first = requireCreatedProcess(created, 0);
    first.timeoutNextRequest();

    const [timedOut] = await Promise.allSettled([
      router.request(
        accountA,
        "accountLoginCancel",
        { loginId: "login-live-wedge" },
      ),
    ]);
    expect(timedOut?.status).toBe("rejected");
    if (timedOut?.status !== "rejected") throw new Error("timed-out mutation resolved");
    expect(timedOut.reason).toMatchObject({
      automaticReplay: false,
      generation: 1,
      intent: "ambiguousMutation",
      reason: "timeout",
    });

    const next = await router.request(accountA, "accountRead", { refreshToken: false });
    expect(next.account).toMatchObject({ email: `${accountA}-2@example.test` });
    expect(created).toHaveLength(2);
    expect(created[0]?.requests).toEqual([{
      key: "accountLoginCancel",
      input: { loginId: "login-live-wedge" },
    }]);
    expect(created[0]?.expired).toEqual(["protocol_fault"]);
    expect(created[1]?.generation).toBe(2);
    expect(created[1]?.requests).toEqual([{
      key: "accountRead",
      input: { refreshToken: false },
    }]);
  });

  test("never sends generation-bound authority through a replacement process", async () => {
    const created: FakeProcess[] = [];
    let releaseDelay: () => void = () => undefined;
    let announceDelay: () => void = () => undefined;
    const delay = new Promise<void>((resolve) => {
      releaseDelay = resolve;
    });
    const delayStarted = new Promise<void>((resolve) => {
      announceDelay = resolve;
    });
    const router = new AccountRuntimeRouter({
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
      policy: {
        initialDelayMs: 1,
        maximumDelayMs: 1,
        maximumRestartAttempts: 1,
      },
      sleep: () => {
        announceDelay();
        return delay;
      },
    });
    await router.ensure(accountA, paths("a"), launchOptions());

    const restart = router.restart(accountA);
    await delayStarted;
    const staleAuthority = router.request(
      accountA,
      "accountLoginCancel",
      { loginId: "old-generation-authority" },
      1,
    );
    releaseDelay();
    await restart;

    const [staleResult] = await Promise.allSettled([staleAuthority]);
    expect(staleResult?.status).toBe("rejected");
    if (staleResult?.status !== "rejected") throw new Error("expected stale authority rejection");
    expect(staleResult.reason).toBeInstanceOf(AccountRuntimeStaleRequestError);
    expect(created).toHaveLength(2);
    expect(created[0]?.requests).toEqual([]);
    expect(created[1]?.requests).toEqual([]);
  });

  test("responds only through the profile and generation that owns a server request", async () => {
    const { created, router } = fakeRouter();
    await Promise.all([
      router.ensure(accountA, paths("a"), launchOptions(20)),
      router.ensure(accountB, paths("b"), launchOptions(40)),
    ]);
    const firstA = created.find(
      ({ profileId, generation }) => profileId === accountA && generation === 21,
    );
    if (firstA === undefined) throw new Error("missing account A process");
    const request: CodexServerRequest = {
      generation: 21,
      id: 41,
      requestInstanceId: 1,
      streamPosition: 1,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-fixture",
        turnId: "turn-fixture",
        itemId: "item-fixture",
        startedAtMs: 1,
      },
    };
    await firstA.callbacks.onServerRequest?.(request);

    const [crossAccount] = await Promise.allSettled([
      router.respond(accountB, request, { type: "error", code: -32_600, message: "Unsupported" }),
    ]);
    expect(crossAccount?.status).toBe("rejected");
    if (crossAccount?.status !== "rejected") throw new Error("expected account isolation");
    expect(crossAccount.reason).toBeInstanceOf(AccountRuntimeStaleRequestError);

    await router.restart(accountA);
    const [stale] = await Promise.allSettled([
      router.respond(accountA, request, { type: "error", code: -32_600, message: "Expired" }),
    ]);
    expect(stale?.status).toBe("rejected");
    if (stale?.status !== "rejected") throw new Error("expected generation isolation");
    expect(stale.reason).toBeInstanceOf(AccountRuntimeStaleRequestError);

    const secondA = created.find(
      ({ profileId, generation }) => profileId === accountA && generation === 22,
    );
    if (secondA === undefined) throw new Error("missing replacement account A process");
    const currentRequest: CodexServerRequest = {
      ...request,
      generation: 22,
      id: 42,
      requestInstanceId: 1,
    };
    await secondA.callbacks.onServerRequest?.(currentRequest);
    await router.respond(accountA, currentRequest, {
      type: "error",
      code: -32_601,
      message: "Not implemented",
    });
    expect(secondA.responses).toEqual([{
      request: currentRequest,
      response: { type: "error", code: -32_601, message: "Not implemented" },
    }]);
  });

  test("stops one account independently and then stops every remaining process", async () => {
    const created: FakeProcess[] = [];
    const stopped: Array<Readonly<{
      accountProfileId: AccountSummary["id"];
      cause: string;
    }>> = [];
    const router = new AccountRuntimeRouter({
      callbacks: {
        onState(accountProfileId, state, cause) {
          if (state.type === "stopped") stopped.push({ accountProfileId, cause });
        },
      },
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
    });
    await Promise.all([
      router.ensure(accountA, paths("a"), launchOptions()),
      router.ensure(accountB, paths("b"), launchOptions()),
    ]);
    const firstA = created.find(({ profileId }) => profileId === accountA);
    const firstB = created.find(({ profileId }) => profileId === accountB);
    if (firstA === undefined || firstB === undefined) throw new Error("missing fake processes");

    await router.stop(accountA);
    expect(router.isRunning(accountA)).toBeFalse();
    expect(router.isRunning(accountB)).toBeTrue();
    expect(firstA.expired).toEqual(["stopped"]);
    expect(firstB.expired).toEqual([]);
    expect(stopped).toEqual([{
      accountProfileId: accountA,
      cause: "explicit_stop",
    }]);

    await router.stopAll();
    expect(router.isRunning(accountB)).toBeFalse();
    expect(firstB.expired).toEqual(["stopped"]);
    expect(stopped).toEqual([
      { accountProfileId: accountA, cause: "explicit_stop" },
      { accountProfileId: accountB, cause: "router_shutdown" },
    ]);
  });

  test("exact-generation fences coalesce, spare newer runtimes, and recover lazily", async () => {
    const created: FakeProcess[] = [];
    const persistedGenerations: number[] = [];
    const router = new AccountRuntimeRouter({
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
    });
    const options = launchOptions(0, (generation) => {
      persistedGenerations.push(generation);
    });
    const firstObservation = await router.ensure(accountA, paths("exact-fence"), options);
    const first = requireCreatedProcess(created, 0);
    const secondObservation = await router.restart(accountA);
    const second = requireCreatedProcess(created, 1);
    expect(firstObservation).toEqual({ generation: 1, status: "running" });
    expect(secondObservation).toEqual({ generation: 2, status: "running" });
    expect("protocol" in firstObservation).toBeFalse();

    expect(await router.fenceGeneration(accountA, first.generation)).toBe("already_fenced");
    expect(router.generation(accountA)).toBe(second.generation);
    expect(router.isRunning(accountA)).toBeTrue();
    expect(second.expired).toEqual([]);

    expect(await Promise.all([
      router.fenceGeneration(accountA, second.generation),
      router.fenceGeneration(accountA, second.generation),
    ])).toEqual(["fenced", "fenced"]);
    expect(second.expired).toEqual(["stopped"]);
    expect(router.generation(accountA)).toBe(second.generation);
    expect(router.isRunning(accountA)).toBeFalse();

    const recovered = await router.request(accountA, "accountRead", { refreshToken: false });
    expect(recovered.account).toMatchObject({
      email: `${accountA}-3@example.test`,
    });
    expect(persistedGenerations).toEqual([1, 2, 3]);
    expect(created.map(({ generation }) => generation)).toEqual([1, 2, 3]);
  });

  test("counts an accepted non-turn callback until its consumer joins", async () => {
    const gate = new ArchiveAdmissionGate();
    const created: FakeProcess[] = [];
    const callbackEntered = deferred<void>();
    const releaseCallback = deferred<void>();
    const router = new AccountRuntimeRouter({
      archiveAdmissionGate: gate,
      callbacks: {
        async onNotification() {
          callbackEntered.resolve();
          await releaseCallback.promise;
        },
      },
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
    });
    await router.ensure(accountA, paths("archive-callback-flight"), launchOptions());
    const process = requireCreatedProcess(created, 0);
    const callback = process.callbacks.onNotification?.({
      generation: process.generation,
      streamPosition: 2,
      method: "account/updated",
      params: { authMode: "chatgpt", planType: "pro" },
    });
    await callbackEntered.promise;

    expect(() => router.assertArchiveTransitionQuiescent(
      accountA,
      process.generation,
    )).toThrow(AccountRuntimeNotQuiescentError);
    expect(gate.isHeld(accountA)).toBeFalse();

    releaseCallback.resolve();
    await callback;
    expect(() => router.assertArchiveTransitionQuiescent(
      accountA,
      process.generation,
    )).not.toThrow();
    await router.stopAll();
  });

  test("keeps a suppressed callback generation quarantined until exact teardown", async () => {
    const gate = new ArchiveAdmissionGate();
    const created: FakeProcess[] = [];
    let callbackDispatches = 0;
    const router = new AccountRuntimeRouter({
      archiveAdmissionGate: gate,
      callbacks: {
        onServerRequest() {
          callbackDispatches += 1;
        },
      },
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
    });
    await router.ensure(accountA, paths("archive-callback-quarantine"), launchOptions());
    const process = requireCreatedProcess(created, 0);
    router.assertArchiveTransitionQuiescent(accountA, process.generation);
    const provisional = gate.retainProvisional({
      accountProfileId: accountA,
      paneId: "pane-callback-quarantine",
      purpose: "pane_archive",
      transitionId: "transition-callback-quarantine",
    });
    await process.callbacks.onServerRequest?.(
      approvalServerRequest(process.generation, 799),
    );
    expect(callbackDispatches).toBe(0);
    expect(() => router.assertArchiveTransitionProvisionalReleaseSafe(
      accountA,
      process.generation,
    )).toThrow(AccountRuntimeNotQuiescentError);

    gate.abortProvisional(provisional);
    expect(router.request(
      accountA,
      "accountRead",
      { refreshToken: false },
      process.generation,
    )).rejects.toBeInstanceOf(AccountRuntimeNotQuiescentError);
    expect(process.requests).toEqual([]);

    expect(await router.fenceGeneration(accountA, process.generation)).toBe("fenced");
    expect(router.request(
      accountA,
      "accountRead",
      { refreshToken: false },
    )).resolves.toMatchObject({ account: { type: "chatgpt" } });
    expect(created).toHaveLength(2);
    expect(created[1]?.generation).toBe(2);
    await router.stopAll();
  });

  test("refuses archive quarantine while an exact provider turn remains active", async () => {
    const gate = new ArchiveAdmissionGate();
    const created: FakeProcess[] = [];
    const router = new AccountRuntimeRouter({
      archiveAdmissionGate: gate,
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
    });
    await router.ensure(accountA, paths("archive-active-turn"), launchOptions());
    const process = requireCreatedProcess(created, 0);
    await process.callbacks.onNotification?.(turnLifecycleNotification(
      "turn/started",
      process.generation,
      "thread-archive-active",
      "turn-archive-active",
    ));

    expect(() => router.assertArchiveTransitionQuiescent(
      accountA,
      process.generation,
    )).toThrow(AccountRuntimeNotQuiescentError);
    expect(gate.isHeld(accountA)).toBeFalse();

    await process.callbacks.onNotification?.(turnLifecycleNotification(
      "turn/completed",
      process.generation,
      "thread-archive-active",
      "turn-archive-active",
    ));
    expect(() => router.assertArchiveTransitionQuiescent(
      accountA,
      process.generation,
    )).not.toThrow();
    await router.stopAll();
  });

  test("refuses archive quarantine while a provider server request awaits settlement", async () => {
    const gate = new ArchiveAdmissionGate();
    const created: FakeProcess[] = [];
    const router = new AccountRuntimeRouter({
      archiveAdmissionGate: gate,
      callbacks: { onServerRequest: () => undefined },
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
    });
    await router.ensure(accountA, paths("archive-pending-request"), launchOptions());
    const process = requireCreatedProcess(created, 0);
    const request = approvalServerRequest(process.generation, 800);
    await process.callbacks.onServerRequest?.(request);

    expect(() => router.assertArchiveTransitionQuiescent(
      accountA,
      process.generation,
    )).toThrow(AccountRuntimeNotQuiescentError);
    expect(gate.isHeld(accountA)).toBeFalse();

    await router.respond(accountA, request, {
      type: "error",
      code: -32_600,
      message: "Unsupported",
    });
    expect(() => router.assertArchiveTransitionQuiescent(
      accountA,
      process.generation,
    )).not.toThrow();
    await router.stopAll();
  });

  test("refuses archive quarantine while provider login authority remains pending", async () => {
    const gate = new ArchiveAdmissionGate();
    const created: FakeProcess[] = [];
    const router = new AccountRuntimeRouter({
      archiveAdmissionGate: gate,
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
    });
    await router.ensure(accountA, paths("archive-pending-login"), launchOptions());
    const process = requireCreatedProcess(created, 0);
    await router.request(accountA, "accountLoginStart", { type: "chatgpt" });

    expect(() => router.assertArchiveTransitionQuiescent(
      accountA,
      process.generation,
    )).toThrow(AccountRuntimeNotQuiescentError);

    await router.request(accountA, "accountLoginCancel", {
      loginId: "login-router-quiescence",
    });
    expect(() => router.assertArchiveTransitionQuiescent(
      accountA,
      process.generation,
    )).not.toThrow();
    await router.stopAll();
  });

  test("keeps every ordinary provider surface closed until the final archive hold releases", async () => {
    const gate = new ArchiveAdmissionGate();
    const created: FakeProcess[] = [];
    const router = new AccountRuntimeRouter({
      archiveAdmissionGate: gate,
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
    });
    const observation = await router.ensure(
      accountA,
      paths("archive-ordinary"),
      launchOptions(),
    );
    const process = requireCreatedProcess(created, 0);
    expect(observation).toEqual({ generation: 1, status: "running" });
    expect("protocol" in observation).toBeFalse();
    const first = gate.retain(archiveDescriptor("ordinary-first"));
    const second = gate.retain(archiveDescriptor("ordinary-second"));
    const requestCount = process.requests.length;

    const outcomes = await Promise.allSettled([
      router.ensure(accountA, paths("archive-ordinary"), launchOptions()),
      router.request(accountA, "accountRead", { refreshToken: false }),
      router.requestWithResponsePosition(
        accountA,
        "accountRead",
        { refreshToken: false },
      ),
      router.restart(accountA),
      router.stop(accountA),
    ]);
    expect(outcomes.every(({ status }) => status === "rejected")).toBeTrue();
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(ArchiveAdmissionHeldError);
      }
    }
    expect(process.requests).toHaveLength(requestCount);
    expect(created).toHaveLength(1);
    expect(router.isRunning(accountA)).toBeTrue();
    expect(router.generation(accountA)).toBe(1);
    expect(router.configuredAccountProfileIds()).toEqual([accountA]);

    gate.release(first);
    expect(
      router.request(accountA, "accountRead", { refreshToken: false }),
    ).rejects.toBeInstanceOf(ArchiveAdmissionHeldError);
    gate.release(second);
    expect(
      router.request(accountA, "accountRead", { refreshToken: false }),
    ).resolves.toMatchObject({ account: { type: "chatgpt" } });
  });

  test("suppresses capabilities, callbacks, eviction, and fault restart while held", async () => {
    const gate = new ArchiveAdmissionGate();
    const created: FakeProcess[] = [];
    const serverRequests: CodexServerRequest[] = [];
    const dynamicRequests: PinnedCodexDynamicToolRequest[] = [];
    const providerEvents: string[] = [];
    const stateEvents: string[] = [];
    const router = new AccountRuntimeRouter({
      archiveAdmissionGate: gate,
      callbacks: {
        onDynamicToolRequest(_accountProfileId, request) {
          dynamicRequests.push(request);
        },
        onServerRequest(_accountProfileId, request) {
          serverRequests.push(request);
        },
        onDiagnostic() {
          providerEvents.push("diagnostic");
        },
        onNotification() {
          providerEvents.push("notification");
        },
        onServerRequestExpired() {
          providerEvents.push("expired");
        },
        onState(_accountProfileId, state) {
          stateEvents.push(state.type);
        },
      },
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
      dynamicToolCapability: async ({ accountProfileId, generation }) =>
        await dynamicToolCapability(accountProfileId, generation),
      policy: {
        initialDelayMs: 1,
        maximumDelayMs: 1,
        maximumRestartAttempts: 1,
      },
      sleep: () => Promise.resolve(),
    });
    await router.ensure(accountA, paths("archive-callbacks"), launchOptions());
    const process = requireCreatedProcess(created, 0);
    expect(router.supportsDynamicTool(accountA, 1)).toBeTrue();
    expect(router.readDynamicToolCapability(accountA, 1)).not.toBeNull();
    stateEvents.length = 0;

    const handle = gate.retain(archiveDescriptor("callbacks"));
    expect(router.supportsDynamicTool(accountA, 1)).toBeFalse();
    expect(router.readDynamicToolCapability(accountA, 1)).toBeNull();
    const serverRequest = approvalServerRequest(process.generation, 801);
    const dynamicRequest = archiveDynamicToolRequest(process.generation);
    await process.callbacks.onServerRequest?.(serverRequest);
    await process.callbacks.onDynamicToolRequest?.(dynamicRequest);
    await process.callbacks.onNotification?.({
      generation: 1,
      streamPosition: 2,
      method: "account/updated",
      params: { authMode: "chatgpt", planType: "pro" },
    });
    await process.callbacks.onDiagnostic?.({
      type: "unknown_notification",
      generation: 1,
      method: "future/notification",
    });
    await process.callbacks.onServerRequestExpired?.({
      type: "server_request_expired",
      generation: 1,
      method: "future/request",
      reason: "unsupported_method",
    });
    expect(serverRequests).toEqual([]);
    expect(dynamicRequests).toEqual([]);
    expect(providerEvents).toEqual([]);

    process.fault("process_exited");
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(created).toHaveLength(1);
    expect(router.generation(accountA)).toBe(1);
    expect(await router.fenceGeneration(accountA, 1)).toBe("fenced");
    expect(process.expired).toEqual(["stopped"]);
    expect(stateEvents).toEqual(["stopped"]);
    gate.release(handle);
    await router.stopAll();
  });

  test("rechecks ordinary admission at every asynchronous provider boundary", async () => {
    {
      const gate = new ArchiveAdmissionGate();
      const created: FakeProcess[] = [];
      let persisted = 0;
      const router = new AccountRuntimeRouter({
        archiveAdmissionGate: gate,
        createProcess(input) {
          const process = new FakeProcess(input);
          created.push(process);
          return Promise.resolve(process);
        },
        policy: {
          initialDelayMs: 1,
          maximumDelayMs: 1,
          maximumRestartAttempts: 1,
        },
        sleep: () => Promise.resolve(),
      });
      expect(router.ensure(
        accountA,
        paths("race-before-create"),
        launchOptions(0, () => {
          persisted += 1;
          gate.retain(archiveDescriptor("race-before-create"));
        }),
      )).rejects.toBeInstanceOf(Error);
      expect(persisted).toBe(1);
      expect(created).toEqual([]);
      await router.stopAll();
    }
    const creationBoundaries = [
      "capacity_admission",
      "dynamic_tool_capability",
      "process_creation",
    ] as const;
    for (const boundary of creationBoundaries) {
      const gate = new ArchiveAdmissionGate();
      const created: FakeProcess[] = [];
      let retained: ArchiveAdmissionHandle | null = null;
      let resolutions = 0;
      const router = new AccountRuntimeRouter({
        archiveAdmissionGate: gate,
        callbacks: { onDynamicToolRequest: () => undefined },
        createProcess(input) {
          const process = new FakeProcess(input);
          created.push(process);
          return Promise.resolve(process);
        },
        dynamicToolCapability: async ({ accountProfileId, generation }) => {
          resolutions += 1;
          return await dynamicToolCapability(accountProfileId, generation);
        },
        policy: {
          initialDelayMs: 1,
          maximumDelayMs: 1,
          maximumRestartAttempts: 1,
        },
        sleep: () => Promise.resolve(),
        testHooks: {
          beforeBoundary(input) {
            if (input.boundary === boundary && retained === null) {
              retained = gate.retain(archiveDescriptor(`race-${boundary}`));
            }
          },
        },
      });
      expect(
        router.ensure(accountA, paths(`race-${boundary}`), launchOptions()),
      ).rejects.toBeInstanceOf(Error);
      expect(retained).not.toBeNull();
      expect(created).toHaveLength(0);
      if (boundary === "dynamic_tool_capability") expect(resolutions).toBe(0);
      if (boundary === "process_creation") expect(resolutions).toBe(1);
      await router.stopAll();
    }

    const rpcBoundaries = [
      "request",
      "request_with_position",
      "restart",
      "respond",
    ] as const;
    for (const boundary of rpcBoundaries) {
      const gate = new ArchiveAdmissionGate();
      const created: FakeProcess[] = [];
      let armed = false;
      let retained: ArchiveAdmissionHandle | null = null;
      const router = new AccountRuntimeRouter({
        archiveAdmissionGate: gate,
        callbacks: { onServerRequest: () => undefined },
        createProcess(input) {
          const process = new FakeProcess(input);
          created.push(process);
          return Promise.resolve(process);
        },
        testHooks: {
          beforeBoundary(input) {
            if (armed && input.boundary === boundary && retained === null) {
              retained = gate.retain(archiveDescriptor(`race-${boundary}`));
            }
          },
        },
      });
      await router.ensure(
        accountA,
        paths(`race-${boundary}`),
        launchOptions(),
      );
      const process = requireCreatedProcess(created, 0);
      const request = approvalServerRequest(process.generation, 900);
      if (boundary === "respond") await process.callbacks.onServerRequest?.(request);
      armed = true;
      const operation = boundary === "request"
        ? router.request(accountA, "accountRead", { refreshToken: false })
        : boundary === "request_with_position"
          ? router.requestWithResponsePosition(
              accountA,
              "accountRead",
              { refreshToken: false },
            )
          : boundary === "restart"
            ? router.restart(accountA)
            : router.respond(accountA, request, {
                type: "error",
                code: -32_600,
                message: "quarantined",
              });
      expect(operation).rejects.toBeInstanceOf(ArchiveAdmissionHeldError);
      expect(retained).not.toBeNull();
      expect(process.requests).toEqual([]);
      expect(process.responses).toEqual([]);
      expect(created).toHaveLength(1);
      expect(process.expired).toEqual([]);
      await router.stopAll();
    }
  });

  test("admits only exact handle-bound archive and strict-cut reconciliation requests", async () => {
    const gate = new ArchiveAdmissionGate();
    const created: FakeProcess[] = [];
    let capabilityResolutions = 0;
    const stateEvents: string[] = [];
    const router = new AccountRuntimeRouter({
      archiveAdmissionGate: gate,
      callbacks: {
        onDynamicToolRequest: () => undefined,
        onState(_accountProfileId, state) {
          stateEvents.push(state.type);
        },
      },
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
      dynamicToolCapability: () => {
        capabilityResolutions += 1;
        return null;
      },
    });
    const provisional = gate.retainProvisional({
      accountProfileId: accountA,
      paneId: "pane-recovery",
      purpose: "pane_archive",
      transitionId: "transition-recovery",
    });
    const preparedHandle = gate.promote(
      provisional,
      archiveDescriptor("recovery"),
    );
    const recoveryObservation = await router.ensureArchiveRecovery(
      accountA,
      paths("archive-recovery"),
      launchOptions(),
      preparedHandle,
    );
    const directProcess = requireCreatedProcess(created, 0);
    expect(recoveryObservation).toEqual({ generation: 1, status: "running" });
    expect("protocol" in recoveryObservation).toBeFalse();
    expect(directProcess.dynamicToolCapability).toBeNull();
    expect(directProcess.callbacks.onDynamicToolRequest).toBeDefined();
    expect(capabilityResolutions).toBe(0);
    expect(router.supportsDynamicTool(accountA, 1)).toBeFalse();
    expect(stateEvents).toEqual([]);

    expect(router.requestArchiveRecoveryWithResponsePosition(
      accountA,
      preparedHandle,
      "threadArchive",
      { threadId: "thread-recovery" },
      1,
    )).rejects.toBeInstanceOf(ArchiveAdmissionAuthorityError);
    const directHandle = gate.replace(preparedHandle, archiveDescriptor("recovery", {
      attemptAuthority: { hmac: "c".repeat(64), revision: 5 },
      attemptPhase: "effect_started",
    }));

    expect(router.requestArchiveRecoveryWithResponsePosition(
      accountA,
      directHandle,
      "threadArchive",
      { threadId: "thread-other" },
      1,
    )).rejects.toBeInstanceOf(ArchiveAdmissionAuthorityError);
    expect(router.requestArchiveRecoveryWithResponsePosition(
      accountA,
      directHandle,
      "threadArchive",
      { threadId: "thread-recovery" },
      2,
    )).rejects.toBeInstanceOf(ArchiveAdmissionAuthorityError);
    expect(router.requestArchiveRecoveryWithResponsePosition(
      accountB,
      directHandle,
      "threadArchive",
      { threadId: "thread-recovery" },
      1,
    )).rejects.toBeInstanceOf(ArchiveAdmissionAuthorityError);
    expect(router.requestArchiveRecoveryWithResponsePosition(
      accountA,
      directHandle,
      "accountRead" as "threadArchive",
      { threadId: "thread-recovery" },
      1,
    )).rejects.toBeInstanceOf(ArchiveAdmissionAuthorityError);
    expect(router.requestArchiveRecoveryWithResponsePosition(
      accountA,
      directHandle,
      "threadList",
      { archived: true },
      2,
    )).rejects.toBeInstanceOf(ArchiveAdmissionAuthorityError);
    expect(directProcess.requests).toEqual([]);

    expect(router.requestArchiveRecoveryWithResponsePosition(
      accountA,
      directHandle,
      "threadArchive",
      { threadId: "thread-recovery" },
      1,
    )).resolves.toEqual({ generation: 1, output: undefined, streamPosition: 1 });
    expect(router.requestArchiveRecoveryWithResponsePosition(
      accountA,
      directHandle,
      "threadArchive",
      { threadId: "thread-recovery" },
      1,
    )).rejects.toBeInstanceOf(ArchiveAdmissionAuthorityError);
    expect(await router.fenceGeneration(accountA, 1)).toBe("fenced");
    expect(stateEvents).toEqual(["stopped"]);

    const cutHandle = gate.replace(directHandle, archiveDescriptor("recovery", {
      attemptAuthority: { hmac: "c".repeat(64), revision: 5 },
      attemptPhase: "ambiguous",
      cutAuthority: { hmac: "d".repeat(64), revision: 6 },
      successorGeneration: 2,
    }));
    expect(router.ensureArchiveRecovery(
      accountA,
      paths("archive-recovery"),
      launchOptions(),
      directHandle,
    )).rejects.toBeInstanceOf(ArchiveAdmissionAuthorityError);
    const successor = await router.ensureArchiveRecovery(
      accountA,
      paths("archive-recovery"),
      launchOptions(),
      cutHandle,
    );
    expect(successor.generation).toBe(2);
    expect(created[1]?.dynamicToolCapability).toBeNull();
    expect(capabilityResolutions).toBe(0);
    expect(stateEvents).toEqual(["stopped"]);
    expect(router.requestArchiveRecoveryWithResponsePosition(
      accountA,
      cutHandle,
      "threadList",
      { archived: true },
      1,
    )).rejects.toBeInstanceOf(ArchiveAdmissionAuthorityError);
    expect(router.requestArchiveRecoveryWithResponsePosition(
      accountA,
      cutHandle,
      "threadList",
      { archived: true },
      2,
    )).resolves.toMatchObject({
      generation: 2,
      output: { data: [], nextCursor: null },
    });
    gate.release(cutHandle);
    expect(
      router.request(accountA, "accountRead", { refreshToken: false }, 2),
    ).resolves.toMatchObject({ account: { type: "chatgpt" } });
  });

  test("consumes the exact authorized thread-archived notification without tainting reuse", async () => {
    const gate = new ArchiveAdmissionGate();
    const created: FakeProcess[] = [];
    let notificationDispatches = 0;
    const router = new AccountRuntimeRouter({
      archiveAdmissionGate: gate,
      callbacks: {
        onNotification() {
          notificationDispatches += 1;
        },
      },
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
    });
    await router.ensure(
      accountA,
      paths("archive-expected-notification"),
      launchOptions(),
    );
    const process = requireCreatedProcess(created, 0);
    router.assertArchiveTransitionQuiescent(accountA, process.generation);
    const provisional = gate.retainProvisional({
      accountProfileId: accountA,
      paneId: "pane-expected-notification",
      purpose: "pane_archive",
      transitionId: "transition-expected-notification",
    });
    const prepared = gate.promote(
      provisional,
      archiveDescriptor("expected-notification"),
    );
    const handle = gate.replace(
      prepared,
      archiveDescriptor("expected-notification", {
        attemptAuthority: { hmac: "c".repeat(64), revision: 5 },
        attemptPhase: "effect_started",
      }),
    );
    process.emitThreadArchivedOnNextArchive();

    expect(router.requestArchiveRecoveryWithResponsePosition(
      accountA,
      handle,
      "threadArchive",
      { threadId: "thread-expected-notification" },
      process.generation,
    )).resolves.toEqual({
      generation: process.generation,
      output: undefined,
      streamPosition: 1,
    });
    expect(notificationDispatches).toBe(0);

    gate.release(handle);
    expect(router.request(
      accountA,
      "accountRead",
      { refreshToken: false },
      process.generation,
    )).resolves.toMatchObject({ account: { type: "chatgpt" } });

    router.assertArchiveTransitionQuiescent(accountA, process.generation);
    const lateProvisional = gate.retainProvisional({
      accountProfileId: accountA,
      paneId: "pane-late-expected-notification",
      purpose: "pane_archive",
      transitionId: "transition-late-expected-notification",
    });
    const latePrepared = gate.promote(
      lateProvisional,
      archiveDescriptor("late-expected-notification"),
    );
    const lateHandle = gate.replace(
      latePrepared,
      archiveDescriptor("late-expected-notification", {
        attemptAuthority: { hmac: "d".repeat(64), revision: 5 },
        attemptPhase: "effect_started",
      }),
    );
    expect(router.requestArchiveRecoveryWithResponsePosition(
      accountA,
      lateHandle,
      "threadArchive",
      { threadId: "thread-late-expected-notification" },
      process.generation,
    )).resolves.toMatchObject({ generation: process.generation });
    gate.release(lateHandle);
    await process.callbacks.onNotification?.({
      generation: process.generation,
      streamPosition: 3,
      method: "thread/archived",
      params: { threadId: "thread-late-expected-notification" },
    });
    expect(notificationDispatches).toBe(0);
    expect(router.request(
      accountA,
      "accountRead",
      { refreshToken: false },
      process.generation,
    )).resolves.toMatchObject({ account: { type: "chatgpt" } });
    await router.stopAll();
  });

  test("rechecks exclusive provider quiescence at the final archive dispatch boundary", async () => {
    const gate = new ArchiveAdmissionGate();
    const created: FakeProcess[] = [];
    let armed = false;
    let callbackDispatches = 0;
    let processAtBoundary: FakeProcess | null = null;
    const router = new AccountRuntimeRouter({
      archiveAdmissionGate: gate,
      callbacks: {
        onServerRequest() {
          callbackDispatches += 1;
        },
      },
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
      testHooks: {
        async beforeBoundary(input) {
          if (!armed || input.boundary !== "archive_recovery_request") return;
          const process = processAtBoundary;
          if (process === null) throw new Error("archive process missing");
          await process.callbacks.onServerRequest?.(
            approvalServerRequest(process.generation, 1_001),
          );
        },
      },
    });
    await router.ensure(accountA, paths("archive-dispatch-race"), launchOptions());
    const process = requireCreatedProcess(created, 0);
    processAtBoundary = process;

    const provisional = gate.retainProvisional({
      accountProfileId: accountA,
      paneId: "pane-dispatch-race",
      purpose: "pane_archive",
      transitionId: "transition-dispatch-race",
    });
    const prepared = gate.promote(
      provisional,
      archiveDescriptor("dispatch-race"),
    );
    const handle = gate.replace(
      prepared,
      archiveDescriptor("dispatch-race", {
        attemptAuthority: { hmac: "c".repeat(64), revision: 5 },
        attemptPhase: "effect_started",
      }),
    );
    armed = true;

    expect(router.requestArchiveRecoveryWithResponsePosition(
      accountA,
      handle,
      "threadArchive",
      { threadId: "thread-dispatch-race" },
      process.generation,
    )).rejects.toBeInstanceOf(AccountRuntimeNotQuiescentError);
    expect(callbackDispatches).toBe(0);
    expect(process.requests).toEqual([]);
    gate.release(handle);
    await router.stopAll();
  });

  test("rejects a clean archive response tainted by a foreign callback in flight", async () => {
    const gate = new ArchiveAdmissionGate();
    const created: FakeProcess[] = [];
    let notificationDispatches = 0;
    const router = new AccountRuntimeRouter({
      archiveAdmissionGate: gate,
      callbacks: {
        onNotification() {
          notificationDispatches += 1;
        },
      },
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
    });
    const provisional = gate.retainProvisional({
      accountProfileId: accountA,
      paneId: "pane-response-callback-race",
      purpose: "pane_archive",
      transitionId: "transition-response-callback-race",
    });
    const prepared = gate.promote(
      provisional,
      archiveDescriptor("response-callback-race"),
    );
    await router.ensureArchiveRecovery(
      accountA,
      paths("archive-response-callback-race"),
      launchOptions(),
      prepared,
    );
    const process = requireCreatedProcess(created, 0);
    const handle = gate.replace(
      prepared,
      archiveDescriptor("response-callback-race", {
        attemptAuthority: { hmac: "c".repeat(64), revision: 5 },
        attemptPhase: "effect_started",
      }),
    );
    const responseGate = deferred<void>();
    process.delayNextArchiveResponse(responseGate.promise);
    const request = router.requestArchiveRecoveryWithResponsePosition(
      accountA,
      handle,
      "threadArchive",
      { threadId: "thread-response-callback-race" },
      process.generation,
    );
    await Bun.sleep(0);
    expect(process.requests).toHaveLength(1);

    await process.callbacks.onNotification?.({
      generation: process.generation,
      streamPosition: 2,
      method: "account/updated",
      params: { authMode: "chatgpt", planType: "pro" },
    });
    expect(notificationDispatches).toBe(0);
    responseGate.resolve();
    expect(request).rejects.toBeInstanceOf(AccountRuntimeNotQuiescentError);
    expect(gate.isHeld(accountA)).toBeTrue();

    gate.release(handle);
    expect(router.request(
      accountA,
      "accountRead",
      { refreshToken: false },
      process.generation,
    )).rejects.toBeInstanceOf(AccountRuntimeNotQuiescentError);
    expect(await router.fenceGeneration(accountA, process.generation))
      .toBe("fenced");
    await router.stopAll();
  });

  test("invalidates an archive response when its exact handle is replaced in flight", async () => {
    const gate = new ArchiveAdmissionGate();
    const created: FakeProcess[] = [];
    const router = new AccountRuntimeRouter({
      archiveAdmissionGate: gate,
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
    });
    const provisional = gate.retainProvisional({
      accountProfileId: accountA,
      paneId: "pane-response-race",
      purpose: "pane_archive",
      transitionId: "transition-response-race",
    });
    const prepared = gate.promote(provisional, archiveDescriptor("response-race"));
    await router.ensureArchiveRecovery(
      accountA,
      paths("archive-response-race"),
      launchOptions(),
      prepared,
    );
    const process = requireCreatedProcess(created, 0);
    const handle = gate.replace(prepared, archiveDescriptor("response-race", {
      attemptAuthority: { hmac: "c".repeat(64), revision: 5 },
      attemptPhase: "effect_started",
    }));
    const responseGate = deferred<void>();
    process.delayNextArchiveResponse(responseGate.promise);
    const request = router.requestArchiveRecoveryWithResponsePosition(
      accountA,
      handle,
      "threadArchive",
      { threadId: "thread-response-race" },
      1,
    );
    await Bun.sleep(0);
    expect(process.requests).toEqual([{
      key: "threadArchive",
      input: { threadId: "thread-response-race" },
    }]);
    const successor = gate.replace(handle, archiveDescriptor("response-race", {
      attemptAuthority: { hmac: "c".repeat(64), revision: 5 },
      attemptPhase: "ambiguous",
      cutAuthority: { hmac: "d".repeat(64), revision: 6 },
      successorGeneration: 2,
    }));
    responseGate.resolve();
    expect(request).rejects.toBeInstanceOf(ArchiveAdmissionAuthorityError);
    expect(process.requests).toHaveLength(1);
    expect(gate.isHeld(accountA)).toBeTrue();
    gate.release(successor);
  });

  test("never relaunches a stopped effect-started source generation", async () => {
    const gate = new ArchiveAdmissionGate();
    const created: FakeProcess[] = [];
    const router = new AccountRuntimeRouter({
      archiveAdmissionGate: gate,
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
    });
    const provisional = gate.retainProvisional({
      accountProfileId: accountA,
      paneId: "pane-stopped-effect",
      purpose: "pane_archive",
      transitionId: "transition-stopped-effect",
    });
    const prepared = gate.promote(
      provisional,
      archiveDescriptor("stopped-effect"),
    );
    await router.ensureArchiveRecovery(
      accountA,
      paths("stopped-effect"),
      launchOptions(),
      prepared,
    );
    const source = requireCreatedProcess(created, 0);
    const effectStarted = gate.replace(prepared, archiveDescriptor("stopped-effect", {
      attemptAuthority: { hmac: "c".repeat(64), revision: 5 },
      attemptPhase: "effect_started",
    }));
    expect(await router.fenceGeneration(accountA, 1)).toBe("fenced");

    expect(router.ensureArchiveRecovery(
      accountA,
      paths("stopped-effect"),
      launchOptions(),
      effectStarted,
    )).rejects.toBeInstanceOf(AccountRuntimeStaleRequestError);
    expect(router.requestArchiveRecoveryWithResponsePosition(
      accountA,
      effectStarted,
      "threadArchive",
      { threadId: "thread-stopped-effect" },
      1,
    )).rejects.toBeInstanceOf(AccountRuntimeStaleRequestError);
    expect(created).toHaveLength(1);
    expect(source.requests).toEqual([]);
  });

  test("creates only the exact contained successor for thread-list reconciliation", async () => {
    const gate = new ArchiveAdmissionGate();
    const created: FakeProcess[] = [];
    const router = new AccountRuntimeRouter({
      archiveAdmissionGate: gate,
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
    });
    const provisional = gate.retainProvisional({
      accountProfileId: accountA,
      paneId: "pane-successor-create",
      purpose: "pane_archive",
      transitionId: "transition-successor-create",
    });
    const prepared = gate.promote(
      provisional,
      archiveDescriptor("successor-create"),
    );
    await router.ensureArchiveRecovery(
      accountA,
      paths("successor-create"),
      launchOptions(),
      prepared,
    );
    const source = requireCreatedProcess(created, 0);
    const effectStarted = gate.replace(prepared, archiveDescriptor("successor-create", {
      attemptAuthority: { hmac: "c".repeat(64), revision: 5 },
      attemptPhase: "effect_started",
    }));
    const ambiguous = gate.replace(effectStarted, archiveDescriptor("successor-create", {
      attemptAuthority: { hmac: "c".repeat(64), revision: 5 },
      attemptPhase: "ambiguous",
      cutAuthority: { hmac: "d".repeat(64), revision: 6 },
      successorGeneration: 2,
    }));
    expect(await router.fenceGeneration(accountA, 1)).toBe("fenced");

    expect(router.requestArchiveRecoveryWithResponsePosition(
      accountA,
      ambiguous,
      "threadList",
      { archived: true },
      2,
    )).resolves.toMatchObject({
      generation: 2,
      output: { data: [], nextCursor: null },
    });
    expect(created.map(({ generation }) => generation)).toEqual([1, 2]);
    expect(source.requests).toEqual([]);
    expect(requireCreatedProcess(created, 1).requests).toEqual([{
      key: "threadList",
      input: { archived: true },
    }]);
  });

  test("gives replayed effect-started admission zero archive mutation authority", async () => {
    const gate = new ArchiveAdmissionGate();
    const created: FakeProcess[] = [];
    const router = new AccountRuntimeRouter({
      archiveAdmissionGate: gate,
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
    });
    await router.ensure(
      accountA,
      paths("replayed-effect"),
      launchOptions(),
    );
    const process = requireCreatedProcess(created, 0);
    const replayed = gate.retain(archiveDescriptor("replayed-effect", {
      attemptAuthority: { hmac: "c".repeat(64), revision: 5 },
      attemptPhase: "effect_started",
    }));
    await router.ensureArchiveRecovery(
      accountA,
      paths("replayed-effect"),
      launchOptions(),
      replayed,
    );

    expect(router.requestArchiveRecoveryWithResponsePosition(
      accountA,
      replayed,
      "threadArchive",
      { threadId: "thread-replayed-effect" },
      1,
    )).rejects.toBeInstanceOf(ArchiveAdmissionAuthorityError);
    expect(process.requests).toEqual([]);
  });

  test("invalidates archive recovery after an account-removal hold wins in flight", async () => {
    const gate = new ArchiveAdmissionGate();
    const created: FakeProcess[] = [];
    const router = new AccountRuntimeRouter({
      archiveAdmissionGate: gate,
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
    });
    const provisional = gate.retainProvisional({
      accountProfileId: accountA,
      paneId: "pane-removal-race",
      purpose: "pane_archive",
      transitionId: "transition-removal-race",
    });
    const prepared = gate.promote(
      provisional,
      archiveDescriptor("removal-race"),
    );
    await router.ensureArchiveRecovery(
      accountA,
      paths("removal-race"),
      launchOptions(),
      prepared,
    );
    const process = requireCreatedProcess(created, 0);
    const effectStarted = gate.replace(prepared, archiveDescriptor("removal-race", {
      attemptAuthority: { hmac: "c".repeat(64), revision: 5 },
      attemptPhase: "effect_started",
    }));
    const responseGate = deferred<void>();
    process.delayNextArchiveResponse(responseGate.promise);
    const request = router.requestArchiveRecoveryWithResponsePosition(
      accountA,
      effectStarted,
      "threadArchive",
      { threadId: "thread-removal-race" },
      1,
    );
    await Bun.sleep(0);
    const removalProvisional = gate.retainAccountRemovalProvisional({
      accountProfileId: accountA,
      expectedGeneration: 1,
      transitionId: "account-removal-race",
    });
    const removal = gate.promoteAccountRemoval(removalProvisional, {
      accountProfileId: accountA,
      cutAuthority: { hmac: "9".repeat(64), revision: 1 },
      expectedGeneration: 1,
      transitionId: "account-removal-race",
    });
    responseGate.resolve();

    expect(request).rejects.toBeInstanceOf(ArchiveAdmissionAuthorityError);
    expect(process.requests).toEqual([{
      key: "threadArchive",
      input: { threadId: "thread-removal-race" },
    }]);
    gate.releaseAccountRemoval(removal);
  });

  test("binds targetless account removal to its exact source-generation fence only", async () => {
    const gate = new ArchiveAdmissionGate();
    const created: FakeProcess[] = [];
    const router = new AccountRuntimeRouter({
      archiveAdmissionGate: gate,
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
    });
    await router.ensure(accountA, paths("account-removal"), launchOptions());
    const process = requireCreatedProcess(created, 0);
    const removal = gate.retainAccountRemoval({
      accountProfileId: accountA,
      cutAuthority: { hmac: "9".repeat(64), revision: 1 },
      expectedGeneration: 1,
      transitionId: "account-removal-router",
    });

    expect(router.stop(accountA)).rejects.toBeInstanceOf(
      ArchiveAdmissionHeldError,
    );
    expect(router.ensureArchiveRecovery(
      accountA,
      paths("account-removal"),
      launchOptions(),
      removal as unknown as ArchiveAdmissionHandle,
    )).rejects.toBeInstanceOf(ArchiveAdmissionAuthorityError);
    expect(router.fenceAccountRemovalGeneration(accountB, removal))
      .rejects.toBeInstanceOf(ArchiveAdmissionAuthorityError);
    expect(await router.fenceAccountRemovalGeneration(accountA, removal)).toBe(
      "fenced",
    );
    expect(process.expired).toEqual(["stopped"]);
    expect(created).toHaveLength(1);
    gate.releaseAccountRemoval(removal);
    expect(router.fenceAccountRemovalGeneration(accountA, removal))
      .rejects.toBeInstanceOf(ArchiveAdmissionAuthorityError);
  });

  test("rejects archive recovery generation floors not authorized by the handle", () => {
    const gate = new ArchiveAdmissionGate();
    const created: FakeProcess[] = [];
    let persisted = 0;
    const router = new AccountRuntimeRouter({
      archiveAdmissionGate: gate,
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
    });
    const handle = gate.retain(archiveDescriptor("generation-floor"));
    expect(router.ensureArchiveRecovery(
      accountA,
      paths("generation-floor"),
      launchOptions(41, () => { persisted += 1; }),
      handle,
    )).rejects.toBeInstanceOf(AccountRuntimeStaleRequestError);
    expect(persisted).toBe(0);
    expect(created).toEqual([]);
    expect(router.configuredAccountProfileIds()).toEqual([]);
    gate.release(handle);
  });

  test("admits no recovery RPC while a cut lacks exact successor authority", () => {
    const gate = new ArchiveAdmissionGate();
    const created: FakeProcess[] = [];
    const router = new AccountRuntimeRouter({
      archiveAdmissionGate: gate,
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
    });
    const direct = gate.retain(archiveDescriptor("cut-intermediate"));
    const cutStarted = gate.replace(direct, archiveDescriptor("cut-intermediate", {
      cutAuthority: { hmac: "d".repeat(64), revision: 6 },
    }));
    expect(router.ensureArchiveRecovery(
      accountA,
      paths("cut-intermediate"),
      launchOptions(),
      cutStarted,
    )).rejects.toBeInstanceOf(ArchiveAdmissionAuthorityError);
    expect(router.requestArchiveRecoveryWithResponsePosition(
      accountA,
      cutStarted,
      "threadArchive",
      { threadId: "thread-cut-intermediate" },
      1,
    )).rejects.toBeInstanceOf(ArchiveAdmissionAuthorityError);
    expect(router.requestArchiveRecoveryWithResponsePosition(
      accountA,
      cutStarted,
      "threadList",
      { archived: true },
      2,
    )).rejects.toBeInstanceOf(ArchiveAdmissionAuthorityError);
    expect(created).toEqual([]);
    expect(router.configuredAccountProfileIds()).toEqual([]);
    gate.release(cutStarted);
  });

  test("cuts callback dispatch when quarantine arrives between ownership checks", async () => {
    const gate = new ArchiveAdmissionGate();
    const created: FakeProcess[] = [];
    const dispatched: CodexServerRequest[] = [];
    let armed = false;
    let handle: ArchiveAdmissionHandle | null = null;
    const router = new AccountRuntimeRouter({
      archiveAdmissionGate: gate,
      callbacks: {
        onServerRequest(_accountProfileId, request) {
          dispatched.push(request);
        },
      },
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
      testHooks: {
        beforeBoundary(input) {
          if (armed && input.boundary === "callback_dispatch" && handle === null) {
            handle = gate.retain(archiveDescriptor("callback-race"));
          }
        },
      },
    });
    await router.ensure(accountA, paths("callback-race"), launchOptions());
    const process = requireCreatedProcess(created, 0);
    const request = approvalServerRequest(process.generation, 1_001);
    armed = true;
    await process.callbacks.onServerRequest?.(request);
    expect(dispatched).toEqual([]);
    expect(handle).not.toBeNull();
    if (handle === null) throw new Error("callback race did not retain authority");
    gate.release(handle);
    expect(router.respond(accountA, request, {
      type: "error",
      code: -32_600,
      message: "stale",
    })).rejects.toBeInstanceOf(AccountRuntimeNotQuiescentError);
    expect(process.responses).toEqual([]);
  });

  test("does not restore callback ownership after a transient archive hold", async () => {
    const gate = new ArchiveAdmissionGate();
    const created: FakeProcess[] = [];
    const serverRequests: CodexServerRequest[] = [];
    const dynamicRequests: PinnedCodexDynamicToolRequest[] = [];
    let holdOrdinal = 0;
    const router = new AccountRuntimeRouter({
      archiveAdmissionGate: gate,
      callbacks: {
        onDynamicToolRequest(_accountProfileId, request) {
          dynamicRequests.push(request);
        },
        onServerRequest(_accountProfileId, request) {
          serverRequests.push(request);
        },
      },
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
      testHooks: {
        beforeBoundary(input) {
          if (input.boundary !== "callback_dispatch") return;
          holdOrdinal += 1;
          const handle = gate.retain(archiveDescriptor(
            `transient-callback-${String(holdOrdinal)}`,
          ));
          gate.release(handle);
        },
      },
    });
    await router.ensure(accountA, paths("transient-callback"), launchOptions());
    const process = requireCreatedProcess(created, 0);
    const serverRequest = approvalServerRequest(process.generation, 1_002);

    await process.callbacks.onServerRequest?.(serverRequest);
    await process.callbacks.onDynamicToolRequest?.(
      archiveDynamicToolRequest(process.generation),
    );

    expect(gate.isHeld(accountA)).toBeFalse();
    expect(serverRequests).toEqual([]);
    expect(dynamicRequests).toEqual([]);
    expect(router.respond(accountA, serverRequest, {
      type: "error",
      code: -32_600,
      message: "revoked",
    })).rejects.toBeInstanceOf(AccountRuntimeNotQuiescentError);
    expect(process.responses).toEqual([]);
    await router.stopAll();
  });

  test("rejects every provider callback before its factory process is accepted", async () => {
    const created: FakeProcess[] = [];
    const dispatched: string[] = [];
    const earlyServerRequest = approvalServerRequest(1, 1_010);
    const router = new AccountRuntimeRouter({
      admissionTimeoutMs: 25,
      callbacks: {
        onDiagnostic() {
          dispatched.push("diagnostic");
        },
        onDynamicToolRequest() {
          dispatched.push("dynamic");
        },
        onNotification() {
          dispatched.push("notification");
        },
        onServerRequest() {
          dispatched.push("server");
        },
        onServerRequestExpired() {
          dispatched.push("expired");
        },
      },
      async createProcess(input) {
        const process = new FakeProcess(input);
        if (input.accountProfileId === accountA) {
          await invokeEveryProviderCallback(
            input.callbacks,
            input.generation,
            earlyServerRequest,
          );
        }
        created.push(process);
        return process;
      },
      maximumLiveProcesses: 1,
    });

    await router.ensure(accountA, paths("factory-callback-a"), launchOptions());
    const first = requireCreatedProcess(created, 0);
    expect(dispatched).toEqual([]);
    expect(router.respond(accountA, earlyServerRequest, {
      type: "error",
      code: -32_600,
      message: "never-owned",
    })).rejects.toBeInstanceOf(AccountRuntimeStaleRequestError);
    expect(first.responses).toEqual([]);

    await router.ensure(accountB, paths("factory-callback-b"), launchOptions());
    expect(created).toHaveLength(2);
    expect(first.expired).toEqual(["stopped"]);
    expect(dispatched).toEqual([]);
    await router.stopAll();
  });

  test("rejects every callback while restart expiration has no current process", async () => {
    const created: FakeProcess[] = [];
    const dispatched: string[] = [];
    const expiringServerRequest = approvalServerRequest(1, 1_011);
    const router = new AccountRuntimeRouter({
      callbacks: {
        onDiagnostic() {
          dispatched.push("diagnostic");
        },
        onDynamicToolRequest() {
          dispatched.push("dynamic");
        },
        onNotification() {
          dispatched.push("notification");
        },
        onServerRequest() {
          dispatched.push("server");
        },
        onServerRequestExpired() {
          dispatched.push("expired");
        },
      },
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
      policy: {
        initialDelayMs: 1,
        maximumDelayMs: 1,
        maximumRestartAttempts: 1,
      },
      sleep: () => Promise.resolve(),
    });
    await router.ensure(accountA, paths("expiration-callback"), launchOptions());
    const first = requireCreatedProcess(created, 0);
    first.onExpire(async () => {
      await invokeEveryProviderCallback(
        first.callbacks,
        first.generation,
        expiringServerRequest,
      );
    });

    expect(await router.restart(accountA)).toEqual({
      generation: 2,
      status: "running",
    });
    expect(dispatched).toEqual([]);
    expect(created.map(({ generation }) => generation)).toEqual([1, 2]);
    expect(router.respond(accountA, expiringServerRequest, {
      type: "error",
      code: -32_600,
      message: "expired-owner",
    })).rejects.toBeInstanceOf(AccountRuntimeStaleRequestError);
    expect(first.responses).toEqual([]);
    await router.stopAll();
  });

  test("cuts process creation and capability resolution when shutdown wins a yield", async () => {
    {
      const created: FakeProcess[] = [];
      let shutdown: Promise<void> | null = null;
      const router = new AccountRuntimeRouter({
        createProcess(input) {
          const process = new FakeProcess(input);
          created.push(process);
          return Promise.resolve(process);
        },
        testHooks: {
          beforeBoundary(input) {
            if (input.boundary === "process_creation" && shutdown === null) {
              shutdown = router.stopAll();
            }
          },
        },
      });

      expect(router.ensure(
        accountA,
        paths("shutdown-before-create"),
        launchOptions(),
      )).rejects.toBeInstanceOf(Error);
      await waitForShutdown(shutdown);
      expect(created).toEqual([]);
      expect(router.supportsDynamicTool(accountA)).toBeFalse();
      expect(router.readDynamicToolCapability(accountA, 1)).toBeNull();
    }

    {
      const created: FakeProcess[] = [];
      let resolutions = 0;
      let shutdown: Promise<void> | null = null;
      const router = new AccountRuntimeRouter({
        callbacks: { onDynamicToolRequest: () => undefined },
        createProcess(input) {
          const process = new FakeProcess(input);
          created.push(process);
          return Promise.resolve(process);
        },
        dynamicToolCapability: async ({ accountProfileId, generation }) => {
          resolutions += 1;
          shutdown = router.stopAll();
          await Promise.resolve();
          return await dynamicToolCapability(accountProfileId, generation);
        },
      });

      expect(router.ensure(
        accountA,
        paths("shutdown-in-capability"),
        launchOptions(),
      )).rejects.toBeInstanceOf(Error);
      await waitForShutdown(shutdown);
      expect(resolutions).toBe(1);
      expect(created).toEqual([]);
      expect(router.supportsDynamicTool(accountA)).toBeFalse();
      expect(router.readDynamicToolCapability(accountA, 1)).toBeNull();
    }
  });

  test("cuts every ordinary RPC boundary when shutdown starts during its hook", async () => {
    const boundaries = [
      "request",
      "request_with_position",
      "restart",
      "respond",
    ] as const;
    for (const boundary of boundaries) {
      const created: FakeProcess[] = [];
      let armed = false;
      let shutdown: Promise<void> | null = null;
      const router = new AccountRuntimeRouter({
        callbacks: { onServerRequest: () => undefined },
        createProcess(input) {
          const process = new FakeProcess(input);
          created.push(process);
          return Promise.resolve(process);
        },
        testHooks: {
          beforeBoundary(input) {
            if (armed && input.boundary === boundary && shutdown === null) {
              shutdown = router.stopAll();
            }
          },
        },
      });
      await router.ensure(
        accountA,
        paths(`shutdown-${boundary}`),
        launchOptions(),
      );
      const process = requireCreatedProcess(created, 0);
      const serverRequest = approvalServerRequest(process.generation, 1_100);
      if (boundary === "respond") {
        await process.callbacks.onServerRequest?.(serverRequest);
      }
      armed = true;
      const operation = boundary === "request"
        ? router.request(accountA, "accountRead", { refreshToken: false })
        : boundary === "request_with_position"
          ? router.requestWithResponsePosition(
              accountA,
              "accountRead",
              { refreshToken: false },
            )
          : boundary === "restart"
            ? router.restart(accountA)
            : router.respond(accountA, serverRequest, {
                type: "error",
                code: -32_600,
                message: "shutdown",
              });

      expect(operation).rejects.toBeInstanceOf(AccountRuntimeCapacityError);
      await waitForShutdown(shutdown);
      expect(process.requests).toEqual([]);
      expect(process.responses).toEqual([]);
      expect(created).toHaveLength(1);
      expect(router.supportsDynamicTool(accountA)).toBeFalse();
      expect(router.readDynamicToolCapability(accountA, process.generation)).toBeNull();
    }
  });

  test("cuts archive RPC dispatch when shutdown starts at its final boundary", async () => {
    const gate = new ArchiveAdmissionGate();
    const created: FakeProcess[] = [];
    let armed = false;
    let shutdown: Promise<void> | null = null;
    const router = new AccountRuntimeRouter({
      archiveAdmissionGate: gate,
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
      testHooks: {
        beforeBoundary(input) {
          if (
            armed && input.boundary === "archive_recovery_request" &&
            shutdown === null
          ) {
            shutdown = router.stopAll();
          }
        },
      },
    });
    const provisional = gate.retainProvisional({
      accountProfileId: accountA,
      paneId: "pane-shutdown-archive",
      purpose: "pane_archive",
      transitionId: "transition-shutdown-archive",
    });
    const prepared = gate.promote(
      provisional,
      archiveDescriptor("shutdown-archive"),
    );
    await router.ensureArchiveRecovery(
      accountA,
      paths("shutdown-archive"),
      launchOptions(),
      prepared,
    );
    const process = requireCreatedProcess(created, 0);
    const effect = gate.replace(prepared, archiveDescriptor("shutdown-archive", {
      attemptAuthority: { hmac: "c".repeat(64), revision: 5 },
      attemptPhase: "effect_started",
    }));
    armed = true;

    expect(router.requestArchiveRecoveryWithResponsePosition(
      accountA,
      effect,
      "threadArchive",
      { threadId: "thread-shutdown-archive" },
      process.generation,
    )).rejects.toBeInstanceOf(AccountRuntimeCapacityError);
    await waitForShutdown(shutdown);
    expect(process.requests).toEqual([]);
    gate.release(effect);
  });

  test("cuts server and dynamic callbacks when shutdown starts at dispatch", async () => {
    for (const callbackKind of ["server", "dynamic"] as const) {
      const created: FakeProcess[] = [];
      const dispatched: string[] = [];
      let armed = false;
      let shutdown: Promise<void> | null = null;
      const router = new AccountRuntimeRouter({
        callbacks: {
          onDynamicToolRequest() {
            dispatched.push("dynamic");
          },
          onServerRequest() {
            dispatched.push("server");
          },
        },
        createProcess(input) {
          const process = new FakeProcess(input);
          created.push(process);
          return Promise.resolve(process);
        },
        testHooks: {
          beforeBoundary(input) {
            if (
              armed && input.boundary === "callback_dispatch" &&
              shutdown === null
            ) {
              shutdown = router.stopAll();
            }
          },
        },
      });
      await router.ensure(
        accountA,
        paths(`shutdown-callback-${callbackKind}`),
        launchOptions(),
      );
      const process = requireCreatedProcess(created, 0);
      armed = true;
      if (callbackKind === "server") {
        await process.callbacks.onServerRequest?.(
          approvalServerRequest(process.generation, 1_200),
        );
      } else {
        await process.callbacks.onDynamicToolRequest?.(
          archiveDynamicToolRequest(process.generation),
        );
      }
      await waitForShutdown(shutdown);
      expect(dispatched).toEqual([]);
      expect(router.supportsDynamicTool(accountA)).toBeFalse();
      expect(router.readDynamicToolCapability(accountA, process.generation)).toBeNull();
    }
  });

  test("does not let a sibling N+1 archive handle authorize the N start flight", async () => {
    const gate = new ArchiveAdmissionGate();
    const created: FakeProcess[] = [];
    let siblingAttempt: Promise<unknown> | null = null;
    const router = new AccountRuntimeRouter({
      archiveAdmissionGate: gate,
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
    });
    const source = gate.retain(archiveDescriptor("start-flight-source"));
    const sibling = gate.retain(archiveDescriptor("start-flight-sibling", {
      expectedGeneration: 2,
    }));
    const sourceObservation = await router.ensureArchiveRecovery(
      accountA,
      paths("start-flight"),
      launchOptions(0, async () => {
        siblingAttempt = router.ensureArchiveRecovery(
          accountA,
          paths("start-flight"),
          launchOptions(1),
          sibling,
        );
        await Promise.resolve();
        await Promise.resolve();
      }),
      source,
    );

    expect(sourceObservation).toEqual({ generation: 1, status: "running" });
    if (siblingAttempt === null) throw new Error("missing sibling start attempt");
    expect(siblingAttempt).rejects.toBeInstanceOf(AccountRuntimeStaleRequestError);
    expect(created.map(({ generation }) => generation)).toEqual([1]);
    gate.release(source);
    gate.release(sibling);
    await router.stopAll();
  });

  test("global shutdown ignores a process fault already queued for delivery", async () => {
    const created: FakeProcess[] = [];
    const stopped: Array<Readonly<{
      accountProfileId: AccountSummary["id"];
      cause: string;
    }>> = [];
    const persistedGenerations: number[] = [];
    const router = new AccountRuntimeRouter({
      callbacks: {
        onState(accountProfileId, state, cause) {
          if (state.type === "stopped" || state.type === "failed") {
            stopped.push({ accountProfileId, cause });
          }
        },
      },
      createProcess(input) {
        const process = new FakeProcess(input);
        created.push(process);
        return Promise.resolve(process);
      },
      policy: {
        initialDelayMs: 1,
        maximumDelayMs: 1,
        maximumRestartAttempts: 4,
      },
      sleep: () => Promise.resolve(),
    });
    await router.ensure(accountA, paths("shutdown-race"), {
      initialGeneration: 0,
      beforeCreate(generation) {
        persistedGenerations.push(generation);
      },
    });
    const process = requireCreatedProcess(created, 0);

    process.fault("process_exited");
    await router.stopAll();
    await Promise.resolve();
    await Promise.resolve();

    expect(created).toHaveLength(1);
    expect(persistedGenerations).toEqual([1]);
    expect(router.generation(accountA)).toBe(1);
    expect(router.isRunning(accountA)).toBeFalse();
    expect(stopped).toEqual([{
      accountProfileId: accountA,
      cause: "router_shutdown",
    }]);
  });
});

function approvalServerRequest(
  generation: number,
  id: number,
): CodexServerRequest {
  return {
    generation,
    id,
    requestInstanceId: 1,
    streamPosition: 1,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: `thread-${String(id)}`,
      turnId: `turn-${String(id)}`,
      itemId: `item-${String(id)}`,
      startedAtMs: 1,
    },
  };
}

function archiveDynamicToolRequest(
  generation: number,
): PinnedCodexDynamicToolRequest {
  return {
    method: "item/tool/call",
    params: {
      threadId: "thread-archive-dynamic",
      turnId: "turn-archive-dynamic",
      callId: "call-archive-dynamic",
      namespace: "oprte",
      tool: "rlm_run",
      arguments: { schemaVersion: 1, action: "submit", program: {} },
      argumentsSha256: "b".repeat(64),
    },
    generation,
    id: "dynamic-archive-request",
    requestInstanceId: 1,
    streamPosition: 1,
    accountProfileId: accountA,
    accountGeneration: generation,
  };
}

async function invokeEveryProviderCallback(
  callbacks: CodexRpcCallbacks,
  generation: number,
  serverRequest: CodexServerRequest,
): Promise<void> {
  await callbacks.onNotification?.(turnLifecycleNotification(
    "turn/started",
    generation,
    "thread-early-callback",
    "turn-early-callback",
  ));
  await callbacks.onServerRequest?.(serverRequest);
  await callbacks.onDynamicToolRequest?.(archiveDynamicToolRequest(generation));
  await callbacks.onDiagnostic?.({
    type: "unknown_notification",
    generation,
    method: "early/diagnostic",
  });
  await callbacks.onServerRequestExpired?.({
    type: "server_request_expired",
    generation,
    method: "early/request",
    reason: "unsupported_method",
  });
}

function turnLifecycleNotification(
  method: "turn/started" | "turn/completed",
  generation: number,
  threadId: string,
  turnId: string,
): CodexNotification {
  const params = {
    threadId,
    turn: {
      id: turnId,
      items: [],
      itemsView: "full",
      status: method === "turn/started" ? "inProgress" : "completed",
      error: null,
      startedAt: 1,
      completedAt: method === "turn/started" ? null : 2,
    },
  };
  if (method === "turn/started") {
    const parsed = parseCodexNotification("turn/started", params);
    if (parsed === null) throw new Error("invalid started-turn fixture");
    return {
      generation,
      streamPosition: 1,
      ...parsed,
    };
  }
  const parsed = parseCodexNotification("turn/completed", params);
  if (parsed === null) throw new Error("invalid completed-turn fixture");
  return {
    generation,
    streamPosition: 2,
    ...parsed,
  };
}
