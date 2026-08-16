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
  AccountRuntimePathMismatchError,
  AccountRuntimeRouter,
  AccountRuntimeStaleRequestError,
  type AccountRuntimeFaultReason,
  type AccountRuntimeProcess,
  type AccountRuntimeProcessProtocol,
  type AccountRuntimeProcessFactoryInput,
  type AccountRuntimeRequestKey,
} from "../src/accounts/runtime-router";
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
      if (key === "turnStart") {
        const gate = this.#turnStartResponseGate ?? Promise.resolve();
        this.#turnStartResponseGate = null;
        return gate.then(() => fakePinnedOutput<K>({
          turn: activeTurnFixture(),
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

  expire(reason: CodexGenerationEndReason): void {
    this.expired.push(reason);
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

describe("AccountRuntimeRouter", () => {
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

    const firstA = await router.ensure(accountA, paths("a"), launchOptions());
    const firstB = await router.ensure(accountB, paths("b"), launchOptions());
    const accountC = "acct_account_c" as AccountSummary["id"];
    const processC = await router.ensure(accountC, paths("c"), launchOptions());
    if (
      !(firstA instanceof FakeProcess) || !(firstB instanceof FakeProcess) ||
      !(processC instanceof FakeProcess)
    ) throw new Error("missing capacity fixture process");

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
    const first = await router.ensure(accountA, paths("capacity-fence-a"), launchOptions());
    if (!(first instanceof FakeProcess)) throw new Error("missing capacity-fence process");

    const admitted = router.ensure(accountB, paths("capacity-fence-b"), launchOptions());
    const fenced = router.fenceGeneration(accountA, first.generation);
    expect(await fenced).toBe("fenced");
    const second = await admitted;
    if (!(second instanceof FakeProcess)) throw new Error("missing admitted process");

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
    const processA = await router.ensure(accountA, paths("a"), launchOptions());
    if (!(processA instanceof FakeProcess)) throw new Error("missing active fixture process");
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
    const [processB, processC] = await Promise.all([second, third]);
    if (!(processB instanceof FakeProcess) || !(processC instanceof FakeProcess)) {
      throw new Error("missing queued fixture process");
    }

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
    const processA = await router.ensure(accountA, paths("a"), launchOptions());
    if (!(processA instanceof FakeProcess)) throw new Error("missing response fixture process");
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
    const processB = await second;
    if (!(processB instanceof FakeProcess)) throw new Error("missing replacement fixture process");
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
    const processA = await router.ensure(accountA, paths("a"), launchOptions());
    if (!(processA instanceof FakeProcess)) throw new Error("missing race fixture process");
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

    const processB = await router.ensure(accountB, paths("b"), launchOptions());
    if (!(processB instanceof FakeProcess)) throw new Error("missing race replacement process");
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
    const processA = await router.ensure(accountA, paths("a"), launchOptions());
    if (!(processA instanceof FakeProcess)) throw new Error("missing timeout fixture process");
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
    const processA = await router.ensure(accountA, paths("a"), launchOptions());
    if (!(processA instanceof FakeProcess)) throw new Error("missing request fixture process");
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
    const processB = await second;
    if (!(processB instanceof FakeProcess)) throw new Error("missing admitted fixture process");
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
    expect(first).toBe(second);
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
    const first = await router.ensure(accountA, paths("a"), launchOptions());
    if (!(first instanceof FakeProcess)) throw new Error("missing first fake process");
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
    const first = await router.ensure(accountA, paths("exact-fence"), options);
    if (!(first instanceof FakeProcess)) throw new Error("missing first fence process");
    const second = await router.restart(accountA);
    if (!(second instanceof FakeProcess)) throw new Error("missing second fence process");

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
    const process = await router.ensure(accountA, paths("shutdown-race"), {
      initialGeneration: 0,
      beforeCreate(generation) {
        persistedGenerations.push(generation);
      },
    });
    if (!(process instanceof FakeProcess)) throw new Error("missing shutdown-race process");

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
