import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";

import { CodexError, CodexRemoteError, IndeterminateCodexEffectError } from "../codex/index";
import type {
  CodexAppServerClient,
  CodexCapabilitySnapshot,
  CodexFact,
  CodexPluginCatalog,
  CodexThread,
  CodexTurn,
  ConversationAutomationToolCall,
  LaunchPinnedCodexOptions,
} from "../codex/index";
import { presetRequirements } from "../domain/presets";
import {
  classifyCommand,
  normalizeProviderTitle,
  PinnedCodexRuntimeManager,
  projectBoundedThread,
  projectUtf8Text,
} from "./codex-runtime-adapter";
import type { CodexAccountProjection, CodexSessionObservationError, ProfileAuthority } from "./ports";

const authority = {
  id: "acct_00000000000000000000000000000000",
  generation: 1,
  codexHome: join(tmpdir(), "hra-fake"),
  desktopUserData: join(tmpdir(), "hra-fake-desktop"),
} as const;

const CREDENTIAL_STORE_PREFLIGHT = Object.freeze({
  cliAuth: "file",
  cwd: "/tmp/hra-control-plane/project",
  mcpOauth: "file",
} as const);

type RuntimeManagerOptions = ConstructorParameters<typeof PinnedCodexRuntimeManager>[0];
type TestRuntimeManagerOptions = Omit<RuntimeManagerOptions, "credentialStorePreflight">
  & Partial<Pick<RuntimeManagerOptions, "credentialStorePreflight">>;

let fakeConnectionSequence = 0;

function createRuntimeManager(input: TestRuntimeManagerOptions): PinnedCodexRuntimeManager {
  const launchClient = input.launchClient;
  return new PinnedCodexRuntimeManager({
    credentialStorePreflight: CREDENTIAL_STORE_PREFLIGHT,
    ...input,
    ...(launchClient === undefined
      ? {}
      : {
          launchClient: async (options) => {
            const client = await launchClient(options);
            const mutable = client as unknown as {
              connectionId?: string;
              resumeThread?: CodexAppServerClient["resumeThread"];
            };
            if (typeof mutable.connectionId !== "string") {
              fakeConnectionSequence += 1;
              Object.defineProperty(mutable, "connectionId", {
                configurable: true,
                value: `70000000-0000-4000-8000-${String(fakeConnectionSequence).padStart(12, "0")}`,
              });
            }
            mutable.resumeThread ??= async (threadId: string) => ({
              authority: {
                profileId: options.authority.profileId,
                processGeneration: options.authority.processGeneration,
              },
              value: makeThread([], threadId),
            });
            return client;
          },
        }),
  });
}

const makeTurn = (
  id: string,
  items: CodexTurn["items"],
  status: CodexTurn["status"] = "completed",
): CodexTurn => ({
  id,
  items,
  status,
  startedAt: 1,
  completedAt: status === "inProgress" ? null : 2,
  durationMs: status === "inProgress" ? null : 1_000,
});

const makeThread = (turns: readonly CodexTurn[], id = "thread-1"): CodexThread => ({
  id,
  sessionId: id,
  preview: "Preview",
  ephemeral: false,
  historyMode: "paginated",
  modelProvider: "openai",
  createdAt: 1,
  updatedAt: 2,
  status: { type: "idle" },
  cwd: "/workspace/project",
  name: "Projection test",
  turns,
});

describe("PinnedCodexRuntimeManager", () => {
  test("single-flights an exact resumed thread observation by generation and connection", async () => {
    let resumeCalls = 0;
    let releaseResume!: () => void;
    let markResumeEntered!: () => void;
    const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve; });
    const resumeEntered = new Promise<void>((resolve) => { markResumeEntered = resolve; });
    const providerAuthority = {
      profileId: authority.id,
      processGeneration: authority.generation,
    };
    const connectionId = "71000000-0000-4000-8000-000000000001";
    const fake = {
      state: "ready",
      connectionId,
      resumeThread: async (threadId: string) => {
        resumeCalls += 1;
        markResumeEntered();
        await resumeGate;
        return { authority: providerAuthority, value: makeThread([], threadId) };
      },
      readThread: async (threadId: string, includeTurns: boolean) => {
        expect(includeTurns).toBe(false);
        return { authority: providerAuthority, value: makeThread([], threadId) };
      },
      close: async () => undefined,
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      observer: { account: () => undefined, fact: () => undefined },
      launchClient: async () => fake,
    });

    const first = manager.observeSession({
      authority,
      providerThreadId: "thread-resume",
      signal: new AbortController().signal,
    });
    const second = manager.observeSession({
      authority,
      providerThreadId: "thread-resume",
      signal: new AbortController().signal,
    });
    await resumeEntered;
    expect(resumeCalls).toBe(1);
    releaseResume();
    const observations = await Promise.all([first, second]);
    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({ connectionId, resumed: true });
    expect(observations[1]).toMatchObject({ connectionId, resumed: true });
    await expect(manager.observeSession({
      authority,
      providerThreadId: "thread-resume",
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ connectionId, resumed: true });
    expect(resumeCalls).toBe(1);
    await manager.close();
  });

  test("refreshes a cached observation across idle, active, and idle provider states", async () => {
    let resumeCalls = 0;
    let readCalls = 0;
    let turnListCalls = 0;
    const providerAuthority = {
      profileId: authority.id,
      processGeneration: authority.generation,
    };
    const connectionId = "71000000-0000-4000-8000-000000000004";
    const providerThreadId = "thread-refresh";
    let current = makeThread([], providerThreadId);
    const fake = {
      state: "ready",
      connectionId,
      resumeThread: async (threadId: string) => {
        resumeCalls += 1;
        return { authority: providerAuthority, value: makeThread([], threadId) };
      },
      readThread: async (threadId: string, includeTurns: boolean) => {
        readCalls += 1;
        expect(threadId).toBe(providerThreadId);
        expect(includeTurns).toBe(false);
        return { authority: providerAuthority, value: { ...current, turns: [] } };
      },
      listThreadTurns: async (options: unknown) => {
        turnListCalls += 1;
        expect(options).toEqual({
          threadId: providerThreadId,
          limit: 1,
          sortDirection: "desc",
          itemsView: "notLoaded",
        });
        return {
          authority: providerAuthority,
          value: { data: current.turns.slice(-1).reverse(), nextCursor: null, backwardsCursor: null },
        };
      },
      close: async () => undefined,
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      observer: { account: () => undefined, fact: () => undefined },
      launchClient: async () => fake,
    });
    const observe = async () => await manager.observeSession({
      authority,
      providerThreadId,
      signal: new AbortController().signal,
    });

    await expect(observe()).resolves.toMatchObject({
      connectionId,
      projection: { providerThreadId, status: "idle" },
      resumed: true,
    });
    current = {
      ...makeThread([makeTurn("turn-active", [], "inProgress")], providerThreadId),
      status: { type: "active", activeFlags: [] },
    };
    await expect(observe()).resolves.toMatchObject({
      projection: {
        activeTurnId: "turn-active",
        providerThreadId,
        status: "active",
      },
    });
    current = makeThread([makeTurn("turn-active", [])], providerThreadId);
    const returnedIdle = await observe();
    expect(returnedIdle.projection).toMatchObject({ providerThreadId, status: "idle" });
    expect(returnedIdle.projection).not.toHaveProperty("activeTurnId");
    expect(resumeCalls).toBe(1);
    expect(readCalls).toBe(3);
    expect(turnListCalls).toBe(1);
    await manager.close();
  });

  test("propagates a fresh projection-read error without replaying the cached resume", async () => {
    let resumeCalls = 0;
    let readCalls = 0;
    const providerAuthority = {
      profileId: authority.id,
      processGeneration: authority.generation,
    };
    const providerThreadId = "thread-read-failure";
    const readError = new CodexError("REMOTE_ERROR", "Codex rejected thread/read.");
    const fake = {
      state: "ready",
      connectionId: "71000000-0000-4000-8000-000000000005",
      resumeThread: async (threadId: string) => {
        resumeCalls += 1;
        return { authority: providerAuthority, value: makeThread([], threadId) };
      },
      readThread: async (threadId: string) => {
        readCalls += 1;
        if (readCalls === 1) throw readError;
        return { authority: providerAuthority, value: makeThread([], threadId) };
      },
      close: async () => undefined,
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      observer: { account: () => undefined, fact: () => undefined },
      launchClient: async () => fake,
    });
    const observe = async () => await manager.observeSession({
      authority,
      providerThreadId,
      signal: new AbortController().signal,
    });

    await expect(observe()).rejects.toBe(readError);
    await expect(observe()).resolves.toMatchObject({
      projection: { providerThreadId, status: "idle" },
      resumed: true,
    });
    expect(resumeCalls).toBe(1);
    expect(readCalls).toBe(2);
    await manager.close();
  });

  test("retires an indeterminate resume without retrying it under the same generation", async () => {
    let resumeCalls = 0;
    let closeCalls = 0;
    const fake = {
      state: "ready",
      connectionId: "71000000-0000-4000-8000-000000000002",
      resumeThread: async () => {
        resumeCalls += 1;
        throw new IndeterminateCodexEffectError("thread/resume", 17);
      },
      close: async () => { closeCalls += 1; },
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      observer: { account: () => undefined, fact: () => undefined },
      launchClient: async () => fake,
    });

    await expect(manager.observeSession({
      authority,
      providerThreadId: "thread-resume",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      name: "CodexSessionObservationError",
      reason: "resume_unavailable",
    } satisfies Partial<CodexSessionObservationError>);
    await expect(manager.observeSession({
      authority,
      providerThreadId: "thread-resume",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    expect(resumeCalls).toBe(1);
    expect(closeCalls).toBe(1);
    await manager.close();
  });

  test("caches a determinate resume rejection without retiring or retrying the client", async () => {
    let resumeCalls = 0;
    let readCalls = 0;
    let closeCalls = 0;
    let onFact: LaunchPinnedCodexOptions["onFact"];
    const connectionId = "71000000-0000-4000-8000-000000000003";
    const providerThreadId = "thread-resume";
    const fake = {
      state: "ready",
      connectionId,
      resumeThread: async () => {
        resumeCalls += 1;
        throw new CodexError("REMOTE_ERROR", "Codex rejected thread/resume.");
      },
      readThread: async () => {
        readCalls += 1;
        return {
          authority: { profileId: authority.id, processGeneration: authority.generation },
          value: makeThread([], providerThreadId),
        };
      },
      close: async () => { closeCalls += 1; },
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      observer: { account: () => undefined, fact: () => undefined },
      launchClient: async (options) => {
        onFact = options.onFact;
        return fake;
      },
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(manager.observeSession({
        authority,
        providerThreadId,
        signal: new AbortController().signal,
      })).rejects.toMatchObject({
        name: "CodexSessionObservationError",
        reason: "resume_unavailable",
      });
    }
    expect(resumeCalls).toBe(1);
    await onFact?.({
      authority: { profileId: authority.id, processGeneration: authority.generation },
      value: {
        type: "threadNameUpdated",
        threadId: providerThreadId,
        name: "Provider evidence",
        connectionId,
      },
    });
    await expect(manager.observeSession({
      authority,
      providerThreadId,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ connectionId, resumed: false });
    expect(resumeCalls).toBe(1);
    expect(readCalls).toBe(1);
    expect(closeCalls).toBe(0);
    await manager.close();
    expect(closeCalls).toBe(1);
  });

  test("forwards Codex thread-list cursors and preserves the provider continuation", async () => {
    let requested: Parameters<CodexAppServerClient["listThreads"]>[0] | undefined;
    const providerAuthority = {
      profileId: authority.id,
      processGeneration: authority.generation,
    };
    const fake = {
      state: "ready",
      listThreads: async (options: Parameters<CodexAppServerClient["listThreads"]>[0]) => {
        requested = options;
        return {
          authority: providerAuthority,
          value: {
            data: [makeThread([])],
            nextCursor: "provider-page-3",
            backwardsCursor: null,
          },
        };
      },
      close: async () => undefined,
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      observer: { account: () => undefined, fact: () => undefined },
      launchClient: async () => fake,
    });

    await expect(manager.listSessions({
      authority,
      cursor: "provider-page-2",
      limit: 17,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      nextCursor: "provider-page-3",
      sessions: [{ providerThreadId: "thread-1", title: "Projection test" }],
    });
    expect(requested).toEqual({ cursor: "provider-page-2", limit: 17 });
    await manager.close();
  });

  test("prepares each isolated Codex home and threads its bounded launch policy", async () => {
    const steps: string[] = [];
    const now = () => 12_345;
    let launched: LaunchPinnedCodexOptions | undefined;
    const fake = {
      state: "ready",
      accountRead: async () => ({
        authority: { profileId: authority.id, processGeneration: authority.generation },
        value: { account: null, requiresOpenaiAuth: true },
      }),
      close: async () => undefined,
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      codexEnvironment: async (codexHome) => {
        steps.push(`environment:${codexHome}`);
        return { HOME: "/Users/person", TMPDIR: `${codexHome}/tmp` };
      },
      credentialStorePreflight: {
        cliAuth: "file",
        cwd: "/private/tmp/hra-acceptance/project-a",
        mcpOauth: "file",
      },
      isCurrent: () => true,
      launchClient: async (options) => {
        steps.push("launch");
        launched = options;
        return fake;
      },
      observer: { account: () => undefined, fact: () => undefined },
      now,
      prepareCodexHome: async (codexHome) => {
        steps.push(`prepare:${codexHome}`);
      },
    });

    await manager.readAccount({ authority, signal: new AbortController().signal });
    expect(steps).toEqual([
      `prepare:${authority.codexHome}`,
      `environment:${authority.codexHome}`,
      "launch",
    ]);
    expect(launched).toMatchObject({
      credentialStorePreflight: {
        cliAuth: "file",
        cwd: "/private/tmp/hra-acceptance/project-a",
        mcpOauth: "file",
      },
      environment: {
        HOME: "/Users/person",
        TMPDIR: `${authority.codexHome}/tmp`,
      },
      expectedCodexHome: authority.codexHome,
      now,
    });
    await manager.close();
  });

  test("binds conversation automation and its post-response wake to the exact live connection", async () => {
    const exactConnectionId = "70000000-0000-4000-8000-000000000777";
    let launched: LaunchPinnedCodexOptions | undefined;
    const handled: ConversationAutomationToolCall[] = [];
    const responseWritten: ConversationAutomationToolCall[] = [];
    const fake = {
      state: "ready",
      connectionId: exactConnectionId,
      accountRead: async () => ({
        authority: { profileId: authority.id, processGeneration: authority.generation },
        value: { account: null, requiresOpenaiAuth: true },
      }),
      close: async () => undefined,
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      launchClient: async (options) => {
        launched = options;
        return fake;
      },
      observer: {
        account: () => undefined,
        conversationAutomation: (_authority, call) => {
          handled.push(call);
          return { scope: "conversation", task: { id: "stask_exact" } };
        },
        conversationAutomationResponseWritten: (_authority, call) => {
          responseWritten.push(call);
        },
        fact: () => undefined,
      },
    });

    await manager.readAccount({ authority, signal: new AbortController().signal });
    if (launched === undefined) throw new Error("Missing launch fixture.");
    if (launched.onConversationAutomationToolCall === undefined) {
      throw new Error("Missing conversation automation fixture.");
    }
    if (launched.onConversationAutomationToolResponseWritten === undefined) {
      throw new Error("Missing conversation automation post-response fixture.");
    }
    const connectionId = fake.connectionId;
    expect(connectionId).toBe(exactConnectionId);
    const call = {
      authority: { profileId: authority.id, processGeneration: authority.generation },
      connectionId,
      requestId: { type: "string", value: "tool-request" },
      requestDigest: "a".repeat(64),
      threadId: "thread-exact",
      turnId: "turn-exact",
      callId: "call-exact",
      operation: {
        mode: "create",
        name: "Continue review",
        prompt: "Continue in this conversation.",
        schedule: { kind: "interval_minutes", minutes: 60 },
      },
    } as const satisfies ConversationAutomationToolCall;

    await expect(launched.onConversationAutomationToolCall(call)).resolves.toEqual({
      scope: "conversation",
      task: { id: "stask_exact" },
    });
    expect(handled).toEqual([call]);
    expect(responseWritten).toEqual([]);
    await launched.onConversationAutomationToolResponseWritten(call);
    expect(responseWritten).toEqual([call]);

    const staleConnectionCall = {
      ...call,
      connectionId: "70000000-0000-4000-8000-999999999999",
    };
    await expect(launched.onConversationAutomationToolCall(staleConnectionCall))
      .rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    await launched.onConversationAutomationToolResponseWritten(staleConnectionCall);
    expect(handled).toEqual([call]);
    expect(responseWritten).toEqual([call]);
    await manager.close();
  });

  test("preserves the provider login ID and cancels only that exact current-generation login", async () => {
    const canceled: string[] = [];
    const fake = {
      state: "ready",
      accountRead: async () => ({
        authority: { profileId: authority.id, processGeneration: authority.generation },
        value: { account: null, requiresOpenaiAuth: true },
      }),
      startManagedLogin: async () => ({
        authority: { profileId: authority.id, processGeneration: authority.generation },
        value: {
          type: "chatgptDeviceCode" as const,
          loginId: "provider-login-exact",
          verificationUrl: "https://example.test/device",
          userCode: "CODE-1234",
        },
      }),
      cancelManagedLogin: async (loginId: string) => {
        canceled.push(loginId);
        return {
          authority: { profileId: authority.id, processGeneration: authority.generation },
          value: { status: "canceled" as const },
        };
      },
      close: async () => undefined,
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: (candidate) => candidate.generation === authority.generation,
      observer: { account: () => undefined, fact: () => undefined },
      launchClient: async () => fake,
    });
    await expect(manager.login({
      authority,
      method: "device_code",
      signal: new AbortController().signal,
    })).resolves.toEqual({
      status: "pending",
      loginId: "provider-login-exact",
      verificationUrl: "https://example.test/device",
      userCode: "CODE-1234",
    });
    await expect(manager.cancelLogin({
      authority,
      loginId: "provider-login-exact",
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: "canceled" });
    expect(canceled).toEqual(["provider-login-exact"]);
    await expect(manager.cancelLogin({
      authority: { ...authority, generation: authority.generation + 1 },
      loginId: "wrong-generation",
      signal: new AbortController().signal,
    })).rejects.toThrow("Codex account generation is stale.");
    expect(canceled).toEqual(["provider-login-exact"]);
    await manager.close();
  });

  test("never relaunches a failed app-server process under its ended generation", async () => {
    let state: CodexAppServerClient["state"] = "ready";
    let launches = 0;
    let launched: LaunchPinnedCodexOptions | undefined;
    const facts: CodexFact[] = [];
    const fake = {
      get state() { return state; },
      accountRead: async () => ({
        authority: { profileId: authority.id, processGeneration: authority.generation },
        value: {
          account: { type: "chatgpt", email: "person@example.com", planType: "pro" },
          requiresOpenaiAuth: true,
        },
      }),
      close: async () => undefined,
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      observer: {
        account: () => undefined,
        fact: (_authority, fact) => { facts.push(fact); },
      },
      launchClient: async (options) => {
        launches += 1;
        launched = options;
        return fake;
      },
    });
    await manager.readAccount({ authority, signal: new AbortController().signal });
    state = "failed";
    await expect(manager.readAccount({
      authority,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    expect(launches).toBe(1);
    if (launched === undefined) throw new Error("Missing launch fixture.");
    if (launched.onFact === undefined) throw new Error("Missing fact observer fixture.");
    await launched.onFact({
      authority: { profileId: authority.id, processGeneration: authority.generation },
      value: {
        type: "providerDisconnected",
        connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
        reason: "process_exit",
      },
    });
    expect(facts).toEqual([{
      type: "providerDisconnected",
      connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
      reason: "process_exit",
    }]);
    await expect(manager.readAccount({
      authority,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    expect(launches).toBe(1);
    await manager.close();
  });

  test("routes interaction responses only to the exact live connection and generation", async () => {
    const connectionId = "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b";
    const calls: unknown[] = [];
    const validations: unknown[] = [];
    const inspections: unknown[] = [];
    let clientState: "failed" | "ready" = "ready";
    let delayInspection = false;
    let releaseInspection!: () => void;
    let markInspectionStarted!: () => void;
    const inspectionGate = new Promise<void>((resolve) => { releaseInspection = resolve; });
    const startedInspection = new Promise<void>((resolve) => { markInspectionStarted = resolve; });
    const fake = {
      get state() { return clientState; },
      connectionId,
      accountRead: async () => ({
        authority: { profileId: authority.id, processGeneration: authority.generation },
        value: { account: { type: "chatgpt", email: "person@example.com", planType: "pro" }, requiresOpenaiAuth: true },
      }),
      resolveInteraction: async (input: unknown) => {
        calls.push(input);
        return { responseWritten: true as const };
      },
      validateInteractionResolution: async (input: unknown) => {
        validations.push(input);
        return { responseDigest: "a".repeat(64) };
      },
      inspectInteractionAuthority: async (input: unknown) => {
        inspections.push(input);
        if (delayInspection) {
          markInspectionStarted();
          await inspectionGate;
        }
        return {
          kind: "command_approval" as const,
          command: "git reset --hard HEAD",
          reason: "Apply exact reset",
          availableDecisions: ["accept", "decline", "cancel"],
          workingDirectory: "/workspace",
          environmentId: null,
          commandActions: [],
          networkApprovalContext: null,
          additionalPermissions: null,
          proposedExecpolicyAmendment: null,
          proposedNetworkPolicyAmendments: null,
        };
      },
      validateInteractionTimeout: async (input: unknown) => {
        validations.push(input);
        return { responseDigest: "b".repeat(64) };
      },
      timeoutInteraction: async (input: unknown) => {
        calls.push(input);
        return { responseWritten: true as const };
      },
      close: async () => undefined,
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      observer: { account: () => undefined, fact: () => undefined },
      launchClient: async () => fake,
    });
    await manager.readAccount({ authority, signal: new AbortController().signal });
    const provider = {
      profileId: authority.id,
      processGeneration: authority.generation,
      connectionId,
      requestId: { type: "number" as const, value: 7 },
      method: "item/fileChange/requestApproval",
      requestDigest: "a".repeat(64),
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      approvalId: null,
    };
    const commandProvider = {
      ...provider,
      method: "item/commandExecution/requestApproval",
    } as const;
    await expect(manager.inspectInteractionAuthority({
      authority,
      provider: commandProvider,
      kind: "command_approval",
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ command: "git reset --hard HEAD" });
    expect(inspections).toEqual([{ provider: commandProvider, kind: "command_approval" }]);
    await expect(manager.validateInteractionResolution({
      authority,
      provider,
      kind: "file_change_approval",
      resolution: { kind: "approval_decision", decision: "once" },
      signal: new AbortController().signal,
    })).resolves.toEqual({ responseDigest: "a".repeat(64) });
    expect(validations).toHaveLength(1);
    await expect(manager.resolveInteraction({
      authority,
      provider,
      kind: "file_change_approval",
      resolution: { kind: "approval_decision", decision: "once" },
      deadlineAt: Number.MAX_SAFE_INTEGER,
      signal: new AbortController().signal,
    })).resolves.toEqual({ responseWritten: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ deadlineAt: Number.MAX_SAFE_INTEGER });
    await expect(manager.validateInteractionTimeout({
      authority,
      provider,
      signal: new AbortController().signal,
    })).resolves.toEqual({ responseDigest: "b".repeat(64) });
    await expect(manager.timeoutInteraction({
      authority,
      provider,
      signal: new AbortController().signal,
    })).resolves.toEqual({ responseWritten: true });
    expect(calls).toHaveLength(2);
    await expect(manager.resolveInteraction({
      authority,
      provider,
      kind: "file_change_approval",
      resolution: { kind: "approval_decision", decision: "once" },
      deadlineAt: 0,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "DEADLINE_EXPIRED" });
    expect(calls).toHaveLength(2);
    await expect(manager.validateInteractionResolution({
      authority,
      provider: { ...provider, connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3c" },
      kind: "file_change_approval",
      resolution: { kind: "approval_decision", decision: "once" },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    await expect(manager.resolveInteraction({
      authority,
      provider: { ...provider, connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3c" },
      kind: "file_change_approval",
      resolution: { kind: "approval_decision", decision: "once" },
      deadlineAt: Number.MAX_SAFE_INTEGER,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    await expect(manager.resolveInteraction({
      authority,
      provider: { ...provider, processGeneration: authority.generation + 1 },
      kind: "file_change_approval",
      resolution: { kind: "approval_decision", decision: "once" },
      deadlineAt: Number.MAX_SAFE_INTEGER,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    expect(calls).toHaveLength(2);
    delayInspection = true;
    const staleInspection = manager.inspectInteractionAuthority({
      authority,
      provider: commandProvider,
      kind: "command_approval",
      signal: new AbortController().signal,
    });
    await startedInspection;
    clientState = "failed";
    releaseInspection();
    await expect(staleInspection).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    expect(inspections).toHaveLength(2);
    await manager.close();
  });

  test("projects a terminal-safe deterministic plugin catalog through the read-only client call", async () => {
    const attack = "\u001b]0;owned\u0007\u202etxt";
    const catalog: CodexPluginCatalog = {
      marketplaces: [
        {
          displayName: `Zed ${attack}`,
          name: `z${attack}`,
          plugins: [{
            authPolicy: "ON_USE",
            availability: "AVAILABLE",
            capabilities: ["write", `read${attack}`],
            category: `productivity${attack}`,
            developerName: `Developer${attack}`,
            disabledReason: null,
            displayName: `Files${attack}`,
            eligiblePlanTypes: ["pro", `plus${attack}`],
            enabled: false,
            id: `z-files${attack}`,
            installed: false,
            installPolicy: "AVAILABLE",
            keywords: ["search", `files${attack}`],
            localVersion: null,
            name: `files${attack}`,
            shortDescription: `Search${attack}\nConnected files`,
            sourceType: "remote",
            version: "1.0.0",
          }, {
            authPolicy: "ON_INSTALL",
            availability: "DISABLED_BY_ADMIN",
            capabilities: [],
            category: null,
            developerName: null,
            disabledReason: "disabled_by_admin",
            displayName: "Alpha",
            eligiblePlanTypes: null,
            enabled: false,
            id: "a-plugin",
            installed: false,
            installPolicy: "NOT_AVAILABLE",
            keywords: [],
            localVersion: null,
            name: "alpha",
            shortDescription: null,
            sourceType: "remote",
            version: null,
          }],
        },
        { displayName: "Alpha", name: "a", plugins: [] },
      ],
      featuredPluginIds: [`z-files${attack}`, "a-plugin"],
      marketplaceLoadErrorCount: 1,
      lifecycle: {
        discovery: "available",
        enablement: "no_separate_pinned_method",
        install: "blocked_compound_upstream_effect",
        oauth: "separate_foreground_only",
      },
    };
    const requests: unknown[] = [];
    const credentialStoreChecks: string[] = [];
    const providerAuthority = {
      profileId: authority.id,
      processGeneration: authority.generation,
    };
    const fake = {
      state: "ready",
      assertCredentialStores: async (cwd: string) => {
        credentialStoreChecks.push(cwd);
      },
      listPlugins: async (options: unknown) => {
        requests.push(options);
        return { authority: providerAuthority, value: catalog };
      },
      close: async () => undefined,
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      observer: { account: () => undefined, fact: () => undefined },
      launchClient: async () => fake,
    });

    const projected = await manager.listPlugins({
      authority,
      forceRefetch: true,
      projectRoot: "/workspace/project",
      signal: new AbortController().signal,
    });
    expect(credentialStoreChecks).toEqual(["/workspace/project"]);
    expect(requests).toEqual([{ cwd: "/workspace/project", forceRefetch: true }]);
    expect(projected.marketplaces.map(({ name }) => name)).toEqual([
      "a",
      "z�]0;owned��txt",
    ]);
    expect(projected.marketplaces[1]?.plugins.map(({ id }) => id)).toEqual([
      "a-plugin",
      "z-files�]0;owned��txt",
    ]);
    expect(projected.featuredPluginIds).toEqual([
      "a-plugin",
      "z-files�]0;owned��txt",
    ]);
    expect(projected.marketplaceLoadErrorCount).toBe(1);
    expect(JSON.stringify(projected)).not.toContain("\u001b");
    expect(JSON.stringify(projected)).not.toContain("\u0007");
    expect(JSON.stringify(projected)).not.toContain("\u202e");
    expect(projected.lifecycle).toEqual(catalog.lifecycle);
    await manager.close();
  });

  test("reviews fresh same-generation capabilities immediately before each provider dispatch", async () => {
    const events: string[] = [];
    let discovery = 0;
    const credentialStoreChecks: string[] = [];
    const credentialStoreSignals: Array<AbortSignal | undefined> = [];
    const discoverySignals: Array<AbortSignal | undefined> = [];
    let ephemeral = false;
    let resumeCalls = 0;
    let readCalls = 0;
    let turnListCalls = 0;
    let startTurnFailure: Error | undefined;
    let emitInvalidatingFactBeforeFailure = false;
    let emitDeletionDuringContextualDiscovery = false;
    let onFact: LaunchPinnedCodexOptions["onFact"];
    let sandboxWritableRoots = ["/workspace/project"];
    const providerAuthority = { profileId: authority.id, processGeneration: authority.generation };
    const connectionId = "71000000-0000-4000-8000-000000000006";
    const capabilities = (suffix: string): CodexCapabilitySnapshot => ({
      models: [{
        id: "gpt-6-astra",
        model: "gpt-6-astra",
        displayName: "GPT-6 Astra",
        hidden: false,
        supportedReasoningEfforts: ["max", "ultra"],
        defaultReasoningEffort: "max",
        serviceTiers: [{ id: "priority", name: "Fast", description: "Faster" }],
        defaultServiceTier: null,
        isDefault: true,
      }],
      features: [
        { name: "computer_use", stage: "stable", enabled: true, defaultEnabled: true },
        { name: "plugins", stage: "stable", enabled: true, defaultEnabled: true },
      ],
      permissionProfiles: [{ id: ":workspace", description: null, allowed: true }],
      apps: [{ id: `app-${suffix}`, name: `App ${suffix}`, description: null, isAccessible: true, isEnabled: true, pluginDisplayNames: [`Plugin ${suffix}`] }],
      pluginLifecycle: "unsupported-under-development",
    });
    const fake = {
      state: "ready",
      connectionId,
      assertCredentialStores: async (cwd: string, signal?: AbortSignal) => {
        credentialStoreChecks.push(cwd);
        credentialStoreSignals.push(signal);
      },
      discoverCapabilities: async (options: { signal?: AbortSignal }) => {
        discovery += 1;
        discoverySignals.push(options.signal);
        events.push(`discover:${String(discovery)}:${JSON.stringify(options)}`);
        if (emitDeletionDuringContextualDiscovery) {
          emitDeletionDuringContextualDiscovery = false;
          await onFact?.({
            authority: providerAuthority,
            value: {
              type: "threadDeleted",
              threadId: "thread-1",
              connectionId,
            },
          });
        }
        return { authority: providerAuthority, value: capabilities(discovery <= 2 ? "1" : "2") };
      },
      resolvePreset: (_snapshot: unknown, alias: string, _requirement: unknown, fast: boolean) => {
        events.push(`resolve:${alias}:${String(fast)}`);
        return { alias, model: "gpt-6-astra", effort: "max", serviceTier: fast ? "priority" : null, fast };
      },
      startThread: async (input: unknown) => {
        events.push(`thread:${JSON.stringify(input)}`);
        return {
          authority: providerAuthority,
          value: {
            thread: { ...makeThread([]), ephemeral },
            cwd: "/workspace/project",
            model: "gpt-6-astra",
            modelProvider: "openai",
            reasoningEffort: "max",
            serviceTier: "priority",
            approvalPolicy: "on-request",
            approvalsReviewer: "auto_review",
            sandbox: {
              type: "workspaceWrite",
              writableRoots: sandboxWritableRoots,
              networkAccess: true,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            },
            activePermissionProfile: { id: ":workspace", extends: null },
            runtimeWorkspaceRoots: ["/workspace/project"],
          },
        };
      },
      resumeThread: async (threadId: string) => {
        resumeCalls += 1;
        return { authority: providerAuthority, value: makeThread([], threadId) };
      },
      readThread: async (threadId: string, includeTurns: boolean) => {
        readCalls += 1;
        expect(includeTurns).toBe(false);
        return { authority: providerAuthority, value: makeThread([], threadId) };
      },
      listThreadTurns: async () => {
        turnListCalls += 1;
        return {
          authority: providerAuthority,
          value: { data: [], nextCursor: null, backwardsCursor: null },
        };
      },
      startTurn: async (input: unknown) => {
        events.push(`turn:${JSON.stringify(input)}`);
        const failure = startTurnFailure;
        startTurnFailure = undefined;
        if (failure !== undefined && emitInvalidatingFactBeforeFailure) {
          emitInvalidatingFactBeforeFailure = false;
          await onFact?.({
            authority: providerAuthority,
            value: {
              type: "threadStatusChanged",
              threadId: "thread-1",
              status: { type: "active", activeFlags: [] },
              connectionId,
            },
          });
        }
        if (failure !== undefined) throw failure;
        return { authority: providerAuthority, value: { turn: makeTurn("turn-1", [], "inProgress") } };
      },
      close: async () => undefined,
    } as unknown as CodexAppServerClient;
    let now = 100;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      observer: { account: () => undefined, fact: () => undefined },
      launchClient: async (options) => {
        onFact = options.onFact;
        return fake;
      },
      now: () => now++,
    });

    const sessionReviewSignal = new AbortController().signal;
    const sessionStartSignal = new AbortController().signal;
    const rejectedTurnReviewSignal = new AbortController().signal;
    const invalidatedTurnReviewSignal = new AbortController().signal;
    const turnReviewSignal = new AbortController().signal;
    const sessionReview = await manager.reviewSessionStart({ authority, projectRoot: "/workspace/project", preset: "high", requirement: presetRequirements.high, fast: true, signal: sessionReviewSignal });
    const started = await manager.startSession({ authority, projectRoot: "/workspace/project", review: sessionReview, signal: sessionStartSignal });
    const pristineObservation = await manager.observeSession({
      authority,
      providerThreadId: "thread-1",
      signal: new AbortController().signal,
    });
    const pristineDetail = await manager.readSession({
      authority,
      providerThreadId: "thread-1",
      detail: true,
      signal: new AbortController().signal,
    });
    expect(pristineObservation).toMatchObject({
      connectionId,
      projection: { providerThreadId: "thread-1", status: "idle" },
      resumed: false,
    });
    expect(pristineDetail).toMatchObject({
      providerThreadId: "thread-1",
      status: "idle",
      turns: [],
    });
    expect({ readCalls, resumeCalls, turnListCalls }).toEqual({
      readCalls: 0,
      resumeCalls: 0,
      turnListCalls: 0,
    });
    const rejectedTurnReview = await manager.reviewTurnStart({ authority, providerThreadId: "thread-1", projectRoot: "/workspace/project", preset: "high", requirement: presetRequirements.high, fast: false, signal: rejectedTurnReviewSignal });
    startTurnFailure = new CodexRemoteError(-32_600, "request failed");
    await expect(manager.startTurn({ authority, providerThreadId: "thread-1", projectRoot: "/workspace/project", review: rejectedTurnReview, message: "rejected", clientMessageId: "client-rejected", signal: new AbortController().signal })).rejects.toBeInstanceOf(CodexRemoteError);
    await manager.readSession({
      authority,
      providerThreadId: "thread-1",
      detail: false,
      signal: new AbortController().signal,
    });
    expect({ readCalls, resumeCalls, turnListCalls }).toEqual({
      readCalls: 1,
      resumeCalls: 0,
      turnListCalls: 1,
    });
    const invalidatedTurnReview = await manager.reviewTurnStart({ authority, providerThreadId: "thread-1", projectRoot: "/workspace/project", preset: "high", requirement: presetRequirements.high, fast: false, signal: invalidatedTurnReviewSignal });
    startTurnFailure = new CodexRemoteError(-32_600, "request failed");
    emitInvalidatingFactBeforeFailure = true;
    await expect(manager.startTurn({ authority, providerThreadId: "thread-1", projectRoot: "/workspace/project", review: invalidatedTurnReview, message: "fact then reject", clientMessageId: "client-fact-rejected", signal: new AbortController().signal })).rejects.toBeInstanceOf(CodexRemoteError);
    await manager.readSession({
      authority,
      providerThreadId: "thread-1",
      detail: false,
      signal: new AbortController().signal,
    });
    expect({ readCalls, resumeCalls, turnListCalls }).toEqual({
      readCalls: 2,
      resumeCalls: 0,
      turnListCalls: 2,
    });
    const turnReview = await manager.reviewTurnStart({ authority, providerThreadId: "thread-1", projectRoot: "/workspace/project", preset: "high", requirement: presetRequirements.high, fast: false, signal: turnReviewSignal });
    const turned = await manager.startTurn({ authority, providerThreadId: "thread-1", projectRoot: "/workspace/project", review: turnReview, message: "continue", clientMessageId: "client-1", signal: new AbortController().signal });
    const postTurnObservation = await manager.observeSession({
      authority,
      providerThreadId: "thread-1",
      signal: new AbortController().signal,
    });
    await manager.readSession({
      authority,
      providerThreadId: "thread-1",
      detail: false,
      signal: new AbortController().signal,
    });

    expect(credentialStoreChecks).toEqual([
      "/workspace/project",
      "/workspace/project",
      "/workspace/project",
      "/workspace/project",
      "/workspace/project",
    ]);
    expect(credentialStoreSignals).toEqual([
      sessionReviewSignal,
      sessionStartSignal,
      rejectedTurnReviewSignal,
      invalidatedTurnReviewSignal,
      turnReviewSignal,
    ]);
    expect(discoverySignals).toEqual(credentialStoreSignals);
    expect(events.map((event) => event.split(":", 1)[0])).toEqual(["discover", "resolve", "thread", "discover", "resolve", "discover", "resolve", "turn", "discover", "resolve", "turn", "discover", "resolve", "turn"]);
    expect(postTurnObservation.resumed).toBe(false);
    expect({ readCalls, resumeCalls, turnListCalls }).toEqual({
      readCalls: 4,
      resumeCalls: 0,
      turnListCalls: 3,
    });
    expect(events[0]).toContain('"cwd":"/workspace/project"');
    expect(events[0]).not.toContain('"threadId"');
    expect(events[3]).toContain('"threadId":"thread-1"');
    expect(events[5]).toContain('"threadId":"thread-1"');
    expect(events[8]).toContain('"threadId":"thread-1"');
    expect(events[11]).toContain('"threadId":"thread-1"');
    expect(events[2]).toContain('"review":"auto_review"');
    expect(events[2]).toContain('"permissionProfile":":workspace"');
    expect(events[2]).toContain('"writableRoots":["/workspace/project"]');
    expect(events[13]).toContain('"review":"auto_review"');
    expect(started.effectiveRuntimeProfile).toMatchObject({ observedAt: 100, enabledApps: [{ id: "app-1", pluginDisplayNames: ["Plugin 1"] }] });
    expect(turned.effectiveRuntimeProfile).toMatchObject({ observedAt: 107, enabledApps: [{ id: "app-2", pluginDisplayNames: ["Plugin 2"] }] });
    await onFact?.({
      authority: providerAuthority,
      value: {
        type: "threadStatusChanged",
        threadId: "thread-1",
        status: { type: "notLoaded" },
        connectionId,
      },
    });
    await expect(manager.observeSession({
      authority,
      providerThreadId: "thread-1",
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ resumed: true });
    expect({ readCalls, resumeCalls, turnListCalls }).toEqual({
      readCalls: 5,
      resumeCalls: 1,
      turnListCalls: 3,
    });
    await onFact?.({
      authority: providerAuthority,
      value: {
        type: "threadDeleted",
        threadId: "thread-1",
        connectionId,
      },
    });
    await expect(manager.observeSession({
      authority,
      providerThreadId: "thread-1",
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ resumed: true });
    expect({ readCalls, resumeCalls, turnListCalls }).toEqual({
      readCalls: 6,
      resumeCalls: 2,
      turnListCalls: 3,
    });
    sandboxWritableRoots = [];
    const legacySandboxReview = await manager.reviewSessionStart({ authority, projectRoot: "/workspace/project", preset: "high", requirement: presetRequirements.high, fast: true, signal: new AbortController().signal });
    emitDeletionDuringContextualDiscovery = true;
    await expect(manager.startSession({ authority, projectRoot: "/workspace/project", review: legacySandboxReview, signal: new AbortController().signal })).resolves.toMatchObject({ providerThreadId: "thread-1" });
    await expect(manager.observeSession({
      authority,
      providerThreadId: "thread-1",
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ resumed: true });
    expect({ readCalls, resumeCalls, turnListCalls }).toEqual({
      readCalls: 7,
      resumeCalls: 3,
      turnListCalls: 3,
    });
    sandboxWritableRoots = ["/"];
    const broadRootReview = await manager.reviewSessionStart({ authority, projectRoot: "/workspace/project", preset: "high", requirement: presetRequirements.high, fast: true, signal: new AbortController().signal });
    await expect(manager.startSession({ authority, projectRoot: "/workspace/project", review: broadRootReview, signal: new AbortController().signal })).rejects.toBeInstanceOf(IndeterminateCodexEffectError);
    sandboxWritableRoots = ["/workspace/project"];
    ephemeral = true;
    const rejectedReview = await manager.reviewSessionStart({ authority, projectRoot: "/workspace/project", preset: "high", requirement: presetRequirements.high, fast: true, signal: new AbortController().signal });
    await expect(manager.startSession({ authority, projectRoot: "/workspace/project", review: rejectedReview, signal: new AbortController().signal })).rejects.toBeInstanceOf(IndeterminateCodexEffectError);
    await manager.close();
  });

  test("normalizes provider titles by UTF-8 scalar and classifies commands without exposing assignments", () => {
    const title = normalizeProviderTitle("🙂".repeat(100));
    expect(new TextEncoder().encode(title).byteLength).toBe(320);
    expect(title).not.toContain("�");
    expect(normalizeProviderTitle("\u001b]0;owned\u0007\u202etxt")).toBe("�]0;owned��txt");
    expect(classifyCommand("API_KEY=super-secret /usr/bin/git -C repo commit -m ship")).toBe("git commit");
    expect(classifyCommand("TOKEN=super-secret custom-tool --flag")).toBe("command");
    expect(classifyCommand(["", "Users", "me", ".bun", "bin", "bun"].join("/") + " test ./src")).toBe("bun test");
  });

  test("removes OSC, control, and bidi scalars from transcript and detail text", () => {
    const attack = "\u001b]0;owned\u0007\u202etxt";
    const thread = {
      ...makeThread([makeTurn("turn-safe", [
        { type: "userMessage", id: "user-safe", clientId: "client-safe", text: [`before${attack}\nafter`] },
        { type: "agentMessage", id: "agent-safe", text: attack },
        { type: "reasoning", id: "reason-safe", summary: [attack] },
        { type: "fileChange", id: "file-safe", status: "completed", changedPaths: [`/workspace/project/src/${attack}.ts`] },
      ])]),
      name: attack,
    };
    const projection = projectBoundedThread(thread, true);
    const safe = "�]0;owned��txt";
    expect(projection.title).toBe(safe);
    expect(projection.messages?.map((message) => message.text)).toEqual([`before${safe}\nafter`, safe]);
    expect(projection.turnSummaries?.[0]?.files).toEqual([`src/${safe}.ts`]);
    const detail = (projection.turns as { items: Record<string, unknown>[] }[])[0];
    expect(detail?.items[0]).toMatchObject({ content: [{ text: `before${safe}\nafter` }] });
    expect(detail?.items[1]).toMatchObject({ text: safe });
    expect(detail?.items[2]).toMatchObject({ summary: [{ text: safe }] });
    expect(detail?.items[3]).toMatchObject({ paths: [`src/${safe}.ts`] });
  });

  test("redacts complete transcript secrets and local paths before compact cloud projection", () => {
    const privatePath = ["", "Users", "alice", "private", "token.txt"].join("/");
    const thread = makeThread([makeTurn("turn-private", [
      {
        type: "userMessage",
        id: "user-private",
        clientId: "client-private",
        text: [
          "Before Authorization: Bearer USER-PROJECTION-SECRET-11",
          `Read ${privatePath}`,
        ],
      },
      {
        type: "reasoning",
        id: "reason-private",
        summary: ["device_code=REASONING-PROJECTION-SECRET-22 while checking"],
      },
      {
        type: "agentMessage",
        id: "agent-private",
        text: "Result api_key=ASSISTANT-PROJECTION-SECRET-33 complete",
      },
    ])]);
    const projection = projectBoundedThread(thread, true);
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("PROJECTION-SECRET");
    expect(serialized).not.toContain(privatePath);
    expect(serialized).toContain("[protected]");
    expect(serialized).toContain("[local-path]");
    expect(projection.messages?.map((message) => message.text)).toEqual([
      "Before [protected]",
      "Result [protected] complete",
    ]);
    const detail = (projection.turns as { items: Record<string, unknown>[] }[])[0];
    expect(JSON.stringify(detail?.items)).not.toContain("PROJECTION-SECRET");
    expect(JSON.stringify(detail?.items)).not.toContain(privatePath);
  });

  test("UTF-8 truncation is a scalar-safe prefix with exact byte accounting", () => {
    fc.assert(fc.property(
      fc.array(fc.constantFrom("a", "é", "🙂", "𐐷", "\n"), { maxLength: 200 }),
      fc.integer({ min: 0, max: 128 }),
      (scalars, limit) => {
        const source = scalars.join("");
        const projected = projectUtf8Text(source, limit);
        const encoder = new TextEncoder();
        expect(source.startsWith(projected.text)).toBe(true);
        expect(encoder.encode(projected.text).byteLength).toBeLessThanOrEqual(limit);
        expect(projected.text).not.toMatch(/[\uD800-\uDFFF]$/u);
        if (projected.omission !== undefined) {
          expect(projected.omission.originalUtf8Bytes).toBe(encoder.encode(source).byteLength);
          expect(projected.omission.returnedUtf8Bytes).toBe(encoder.encode(projected.text).byteLength);
          expect(projected.omission.returnedUtf8Bytes + projected.omission.omittedUtf8Bytes)
            .toBe(projected.omission.originalUtf8Bytes);
        }
      },
    ));
    expect(projectUtf8Text("a\uD800b", 100)).toEqual({ text: "a�b" });
  });

  test("keeps an unchanged completed turn byte-identical when a later turn is added", () => {
    const older = makeTurn("turn-older", [
      { type: "userMessage", id: "older-user", clientId: "older-client", text: ["first user display"] },
      ...Array.from({ length: 69 }, (_, index) => ({
        type: "agentMessage" as const,
        id: `older-assistant-${String(index)}`,
        text: `assistant display ${String(index)}`,
      })),
    ]);
    const later = makeTurn("turn-later", [
      { type: "userMessage", id: "later-user", clientId: "later-client", text: ["later user"] },
      { type: "agentMessage", id: "later-assistant", text: "later assistant" },
    ]);
    const snapshotA = projectBoundedThread(makeThread([older]), false);
    const snapshotB = projectBoundedThread(makeThread([older, later]), false);
    const olderMessagesA = snapshotA.messages?.filter((message) => message.turnId === older.id) ?? [];
    const olderMessagesB = snapshotB.messages?.filter((message) => message.turnId === older.id) ?? [];
    const digest = (value: unknown): string => new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(value))
      .digest("hex");

    expect(olderMessagesA.map((message) => [message.role, message.text])).toEqual([
      ["user", "first user display"],
      ["assistant", "assistant display 68"],
    ]);
    expect(JSON.stringify(olderMessagesB)).toBe(JSON.stringify(olderMessagesA));
    expect(digest(olderMessagesB)).toBe(digest(olderMessagesA));
    expect(snapshotA.omission?.omittedMessages).toBe(68);
    expect(snapshotB.messages?.map((message) => `${message.turnId}:${message.role}`)).toEqual([
      "turn-older:user",
      "turn-older:assistant",
      "turn-later:user",
      "turn-later:assistant",
    ]);
    expect(snapshotB.omission?.omittedMessages).toBe(68);
  });

  test("projects first-user and final-assistant bodies per turn independent of later turns", () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 1, max: 12 }), { minLength: 1, maxLength: 23 }),
      (assistantCounts) => {
        const turns = assistantCounts.map((assistantCount, turnIndex) => {
          const turnId = `property-turn-${String(turnIndex).padStart(2, "0")}`;
          return makeTurn(turnId, [
            {
              type: "userMessage",
              id: `${turnId}-user`,
              clientId: `${turnId}-client`,
              text: [`${turnId} first user`, `${turnId} ignored user fragment`],
            },
            ...Array.from({ length: assistantCount }, (_, assistantIndex) => ({
              type: "agentMessage" as const,
              id: `${turnId}-assistant-${String(assistantIndex)}`,
              text: `${turnId} assistant ${String(assistantIndex)}`,
            })),
          ]);
        });
        const before = projectBoundedThread(makeThread(turns), false);
        const later = makeTurn("property-turn-later", [
          { type: "userMessage", id: "later-user", clientId: "later-client", text: ["later first", "later ignored"] },
          { type: "agentMessage", id: "later-middle", text: "later middle" },
          { type: "agentMessage", id: "later-final", text: "later final" },
        ]);
        const after = projectBoundedThread(makeThread([...turns, later]), false);
        const oldTurnIds = new Set(turns.map((turn) => turn.id));
        const beforeBodies = before.messages?.map((message) => ({
          role: message.role,
          text: message.text,
          turnId: message.turnId,
        })) ?? [];
        const afterBodies = after.messages
          ?.filter((message) => message.turnId !== undefined && oldTurnIds.has(message.turnId))
          .map((message) => ({ role: message.role, text: message.text, turnId: message.turnId })) ?? [];
        const expectedBodies = turns.flatMap((turn, turnIndex) => [
          { role: "user" as const, text: `${turn.id} first user`, turnId: turn.id },
          {
            role: "assistant" as const,
            text: `${turn.id} assistant ${String((assistantCounts[turnIndex] ?? 1) - 1)}`,
            turnId: turn.id,
          },
        ]);

        expect(beforeBodies).toEqual(expectedBodies);
        expect(afterBodies).toEqual(beforeBodies);
        expect(before.omission?.omittedMessages).toBe(
          assistantCounts.reduce((total, count) => total + count, 0),
        );
        expect(after.omission?.omittedMessages).toBe(
          assistantCounts.reduce((total, count) => total + count, 0) + 2,
        );
      },
    ), { numRuns: 100 });
  });

  test("keeps proven compact essentials invariant under sibling addition and reordering", () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        user: fc.string({ maxLength: 48 }),
        assistant: fc.string({ maxLength: 48 }),
      }), { maxLength: 22 }),
      fc.nat(),
      (siblingBodies, insertionSeed) => {
        const target = makeTurn("stable-target", [
          { type: "userMessage", id: "tail-steer", clientId: "tail-client", text: ["late steer must not substitute"] },
          { type: "agentMessage", id: "retained-assistant", text: "retained assistant must not substitute" },
        ]);
        const siblings = siblingBodies.map((body, index) => makeTurn(`sibling-${String(index)}`, [
          { type: "userMessage", id: `sibling-user-${String(index)}`, clientId: `sibling-client-${String(index)}`, text: [body.user] },
          { type: "agentMessage", id: `sibling-assistant-${String(index)}`, text: body.assistant },
        ]));
        const insertionIndex = insertionSeed % (siblings.length + 1);
        const reordered = [
          ...siblings.slice(0, insertionIndex),
          target,
          ...siblings.slice(insertionIndex),
        ];
        const stableEssentials = new Map([[target.id, {
          firstUser: {
            role: "user" as const,
            text: "original question",
            turnId: target.id,
            clientId: "original-client",
          },
          finalAssistant: {
            role: "assistant" as const,
            text: "exact final answer",
            turnId: target.id,
          },
        }]]);
        const project = (turns: readonly CodexTurn[]) => projectBoundedThread(
          makeThread(turns),
          false,
          false,
          new Set(),
          new Set(),
          new Map(),
          stableEssentials,
        ).messages?.filter((message) => message.turnId === target.id) ?? [];

        expect(project(reordered)).toEqual(project([target]));
        expect(project(reordered)).toEqual([
          { role: "user", text: "original question", turnId: target.id, clientId: "original-client" },
          { role: "assistant", text: "exact final answer", turnId: target.id },
        ]);
      },
    ), { numRuns: 100 });
  });

  test("bounds long Unicode sessions below four MiB and exposes safe summaries", () => {
    const huge = "🙂".repeat(100_000);
    const turns = Array.from({ length: 1_000 }, (_, index) => makeTurn(`turn-${String(index)}`, [
      { type: "userMessage", id: `user-${String(index)}`, clientId: `client-${String(index)}`, text: [huge] },
      { type: "agentMessage", id: `agent-${String(index)}`, text: huge },
      { type: "reasoning", id: `reason-${String(index)}`, summary: ["private chain"] },
      { type: "commandExecution", id: `cmd-${String(index)}`, command: "TOKEN=secret git status", cwd: "/workspace/project", status: "completed", exitCode: 0, durationMs: 20 },
      { type: "fileChange", id: `file-${String(index)}`, status: "completed", changedPaths: ["/workspace/project/src/index.ts", "/outside/secret"] },
    ]));
    const projection = projectBoundedThread(makeThread(turns), false);
    expect(projection.turnSummaries).toHaveLength(24);
    expect(projection.messages).toHaveLength(48);
    expect(projection.omission).toMatchObject({ hasMoreOlderTurns: true, truncatedMessages: 48 });
    expect(projection.turnSummaries?.[0]).toMatchObject({
      files: ["src/index.ts"],
      actions: ["git status"],
    });
    expect(JSON.stringify(projection)).not.toContain("private chain");
    expect(JSON.stringify(projection)).not.toContain("TOKEN=secret");
    expect(new TextEncoder().encode(JSON.stringify(projection)).byteLength).toBeLessThan(4 * 1024 * 1024);
  });

  test("keeps detailed sessions transport-safe under JSON-expanding text and paths", () => {
    const expanding = "\\".repeat(100_000);
    const expandingPath = "\\".repeat(5_000);
    const paths = Array.from({ length: 128 }, (_, index) => `/workspace/project/${String(index)}-${expandingPath}`);
    const turns = Array.from({ length: 24 }, (_, index) => makeTurn(`turn-detail-${String(index)}`, [
      { type: "userMessage", id: `user-${String(index)}`, clientId: `client-${String(index)}`, text: [expanding] },
      { type: "agentMessage", id: `agent-${String(index)}`, text: expanding },
      { type: "reasoning", id: `reason-${String(index)}`, summary: [expanding] },
      { type: "fileChange", id: `files-${String(index)}`, status: "completed", changedPaths: paths },
    ]));

    const projection = projectBoundedThread(makeThread(turns), true);
    const bytes = new TextEncoder().encode(JSON.stringify(projection)).byteLength;
    expect(bytes).toBeLessThanOrEqual(3 * 1024 * 1024);
    expect(projection.omission?.omittedMessages).toBe(0);
    expect(projection.omission?.truncatedMessages).toBeGreaterThan(0);
    expect(projection.turnSummaries?.reduce((total, turn) => total + turn.omittedFiles, 0)).toBeGreaterThan(0);
    expect((projection.turns as { omission: { omittedLoadedItems: number } }[])
      .reduce((total, turn) => total + turn.omission.omittedLoadedItems, 0)).toBeGreaterThan(0);
  });

  test("hydrates bounded recent turn items for messages, files, and actions in chronological order", async () => {
    const calls: unknown[] = [];
    const fake = {
      state: "ready",
      readThread: async (threadId: string, includeTurns: boolean) => {
        calls.push({ method: "read", threadId, includeTurns });
        return { authority: { profileId: authority.id, processGeneration: 1 }, value: makeThread([]) };
      },
      listThreadTurns: async (options: unknown) => {
        calls.push({ method: "turns", options });
        return {
          authority: { profileId: authority.id, processGeneration: 1 },
          value: {
            data: [makeTurn("new", [{ type: "agentMessage", id: "a", text: "new" }]), makeTurn("old", [{ type: "userMessage", id: "u", clientId: "client-old", text: ["old"] }])],
            nextCursor: "older",
            backwardsCursor: "newer",
          },
        };
      },
      listThreadItems: async (options: { turnId: string }) => {
        calls.push({ method: "items", options });
        const data = options.turnId === "old"
          ? [{ turnId: "old", item: { type: "userMessage", id: "u", clientId: "client-old", text: ["old"] } }]
          : [
              { turnId: "new", item: { type: "agentMessage", id: "a", text: "new" } },
              { turnId: "new", item: { type: "fileChange", id: "file", status: "completed", changedPaths: ["/workspace/project/src/index.ts"] } },
              { turnId: "new", item: { type: "commandExecution", id: "command", command: "git status", cwd: "/workspace/project", status: "completed", exitCode: 0, durationMs: 5 } },
            ];
        return { authority: { profileId: authority.id, processGeneration: 1 }, value: { data, nextCursor: null, backwardsCursor: null } };
      },
      close: async () => undefined,
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      observer: { account: () => undefined, fact: () => undefined },
      launchClient: async () => fake,
    });
    const projection = await manager.readSession({ authority, providerThreadId: "thread-1", detail: false, signal: new AbortController().signal });
    expect(calls).toEqual([
      { method: "read", threadId: "thread-1", includeTurns: false },
      { method: "turns", options: { threadId: "thread-1", limit: 24, sortDirection: "desc", itemsView: "notLoaded" } },
      { method: "items", options: { threadId: "thread-1", turnId: "new", limit: 64, sortDirection: "asc" } },
      { method: "items", options: { threadId: "thread-1", turnId: "old", limit: 64, sortDirection: "asc" } },
    ]);
    expect(projection.messages?.map((message) => message.text)).toEqual(["old", "new"]);
    expect(projection.turnSummaries?.find((turn) => turn.id === "new")).toMatchObject({ files: ["src/index.ts"], actions: ["git status"] });
    expect(projection.omission?.hasMoreOlderTurns).toBe(true);
    expect(projection.omission?.incompleteTurnIds).toEqual(["new", "old"]);
    await manager.close();
  });

  test("uses the bounded summary compatibility view for legacy thread history", async () => {
    const calls: unknown[] = [];
    const legacyMetadata = { ...makeThread([]), historyMode: "legacy" as const };
    const recentDescending = [
      makeTurn("new", [{ type: "agentMessage", id: "new-answer", text: "new answer" }]),
      makeTurn("old", [{ type: "userMessage", id: "old-user", clientId: "old-client", text: ["old question"] }]),
    ];
    const fake = {
      state: "ready",
      readThread: async () => ({
        authority: { profileId: authority.id, processGeneration: 1 },
        value: legacyMetadata,
      }),
      listThreadTurns: async (options: { itemsView: "notLoaded" | "summary" | "full" }) => {
        calls.push({ method: "turns", options });
        if (options.itemsView === "full") throw new Error("legacy session reads must not request the full multi-turn view");
        return {
          authority: { profileId: authority.id, processGeneration: 1 },
          value: {
            data: options.itemsView === "summary"
              ? recentDescending
              : recentDescending.map((turn) => ({ ...turn, items: [] })),
            nextCursor: null,
            backwardsCursor: "newest",
          },
        };
      },
      listThreadItems: async () => {
        calls.push({ method: "items" });
        throw new Error("legacy history must not request thread/items/list");
      },
      close: async () => undefined,
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      observer: { account: () => undefined, fact: () => undefined },
      launchClient: async () => fake,
    });

    const compact = await manager.readSession({
      authority,
      providerThreadId: "thread-1",
      detail: false,
      signal: new AbortController().signal,
    });
    const detailed = await manager.readSession({
      authority,
      providerThreadId: "thread-1",
      detail: true,
      signal: new AbortController().signal,
    });

    expect(calls).not.toContainEqual({ method: "items" });
    expect(calls).not.toContainEqual(expect.objectContaining({
      method: "turns",
      options: expect.objectContaining({ itemsView: "full" }),
    }));
    expect(compact.messages?.map((message) => message.text)).toEqual(["old question", "new answer"]);
    expect(compact.omission?.unreadItemTurnIds).toEqual(["new", "old"]);
    expect(detailed.turns).toHaveLength(2);
    expect(detailed.omission?.unreadItemTurnIds).toEqual(["new", "old"]);
    await manager.close();
  });

  test("memoizes an exact unsupported item page per thread without downgrading another thread", async () => {
    const itemCalls: string[] = [];
    const fake = {
      state: "ready",
      readThread: async (threadId: string) => ({
        authority: { profileId: authority.id, processGeneration: 1 },
        value: makeThread([], threadId),
      }),
      listThreadTurns: async (options: { threadId: string; itemsView: "notLoaded" | "summary" }) => ({
        authority: { profileId: authority.id, processGeneration: 1 },
        value: {
          data: [makeTurn(`${options.threadId}-turn`, options.itemsView === "summary"
            ? [{ type: "agentMessage", id: `${options.threadId}-answer`, text: options.threadId }]
            : [])],
          nextCursor: null,
          backwardsCursor: "anchor",
        },
      }),
      listThreadItems: async (options: { threadId: string; turnId: string }) => {
        itemCalls.push(options.threadId);
        if (options.threadId === "thread-legacy") {
          throw new CodexRemoteError(-32_601, "request failed");
        }
        return {
          authority: { profileId: authority.id, processGeneration: 1 },
          value: {
            data: [{ turnId: options.turnId, item: { type: "agentMessage", id: "answer", text: "paginated" } }],
            nextCursor: null,
            backwardsCursor: null,
          },
        };
      },
      close: async () => undefined,
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      observer: { account: () => undefined, fact: () => undefined },
      launchClient: async () => fake,
    });

    const read = async (providerThreadId: string) => await manager.readSession({
      authority,
      providerThreadId,
      detail: false,
      signal: new AbortController().signal,
    });
    await read("thread-legacy");
    await read("thread-legacy");
    await expect(read("thread-paginated")).resolves.toMatchObject({
      messages: [{ role: "assistant", text: "paginated" }],
    });
    expect(itemCalls).toEqual(["thread-legacy", "thread-paginated"]);
    await manager.close();
  });

  test("paginates beyond 64 items and keeps deliberate compact bounds cacheable", async () => {
    const calls: unknown[] = [];
    const oversizedAnswer = "🙂".repeat(20_000);
    const changedPaths = Array.from(
      { length: 129 },
      (_, index) => `/workspace/project/src/file-${String(index).padStart(3, "0")}.ts`,
    );
    const fake = {
      state: "ready",
      readThread: async () => ({
        authority: { profileId: authority.id, processGeneration: 1 },
        value: makeThread([]),
      }),
      listThreadTurns: async () => ({
        authority: { profileId: authority.id, processGeneration: 1 },
        value: { data: [makeTurn("long-complete", [])], nextCursor: null, backwardsCursor: null },
      }),
      listThreadItems: async (options: { cursor?: string | null; sortDirection: "asc" | "desc"; turnId: string }) => {
        calls.push(options);
        if (options.sortDirection === "asc" && options.cursor === undefined) {
          return {
            authority: { profileId: authority.id, processGeneration: 1 },
            value: {
              data: [
                { turnId: options.turnId, item: { type: "userMessage", id: "user", clientId: "client", text: ["question"] } },
                ...Array.from({ length: 63 }, (_, index) => ({
                  turnId: options.turnId,
                  item: { type: "reasoning", id: `reason-${String(index)}`, summary: [] },
                })),
              ],
              nextCursor: "page-2",
              backwardsCursor: null,
            },
          };
        }
        return {
          authority: { profileId: authority.id, processGeneration: 1 },
          value: {
            data: [
              { turnId: options.turnId, item: { type: "agentMessage", id: "final", text: oversizedAnswer } },
              { turnId: options.turnId, item: { type: "fileChange", id: "files", status: "completed", changedPaths } },
            ],
            nextCursor: null,
            backwardsCursor: null,
          },
        };
      },
      close: async () => undefined,
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      observer: { account: () => undefined, fact: () => undefined },
      launchClient: async () => fake,
    });

    const projection = await manager.readSession({
      authority,
      providerThreadId: "thread-1",
      detail: false,
      signal: new AbortController().signal,
    });

    expect(calls).toEqual([
      { threadId: "thread-1", turnId: "long-complete", limit: 64, sortDirection: "asc" },
      { threadId: "thread-1", turnId: "long-complete", cursor: "page-2", limit: 64, sortDirection: "asc" },
      { threadId: "thread-1", turnId: "long-complete", limit: 64, sortDirection: "desc" },
    ]);
    expect(projection.messages?.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(projection.messages?.at(-1)).toMatchObject({
      role: "assistant",
      omission: { originalUtf8Bytes: 80_000, returnedUtf8Bytes: 24 * 1024 },
    });
    expect(projection.turnSummaries?.[0]).toMatchObject({ files: changedPaths.slice(0, 128).map((path) => path.slice("/workspace/project/".length)), omittedFiles: 1 });
    expect(projection.omission).toMatchObject({ unreadItemTurnIds: [], incompleteTurnIds: [] });
    expect(new TextEncoder().encode(JSON.stringify(projection)).byteLength).toBeLessThanOrEqual(3 * 1024 * 1024);
    await manager.close();
  });

  test("bounds aggregate hydration and recovers final assistants from deterministic tails", async () => {
    const chronologicalTurns = Array.from(
      { length: 24 },
      (_, index) => makeTurn(`turn-${String(index).padStart(2, "0")}`, []),
    );
    const missingFinalTurnId = "turn-00";
    const hugeAnswer = "\\".repeat(100_000);
    const calls: { cursor?: string | null; sortDirection: "asc" | "desc"; turnId: string }[] = [];
    const fake = {
      state: "ready",
      readThread: async () => ({
        authority: { profileId: authority.id, processGeneration: 1 },
        value: makeThread([]),
      }),
      listThreadTurns: async () => ({
        authority: { profileId: authority.id, processGeneration: 1 },
        value: { data: [...chronologicalTurns].reverse(), nextCursor: null, backwardsCursor: null },
      }),
      listThreadItems: async (options: { cursor?: string | null; sortDirection: "asc" | "desc"; turnId: string }) => {
        calls.push(options);
        if (options.sortDirection === "desc") {
          const tailReasoning = Array.from({ length: 61 }, (_, index) => ({
            turnId: options.turnId,
            item: { type: "reasoning", id: `tail-reason-${String(index)}`, summary: [] },
          }));
          if (options.turnId === "turn-23") {
            tailReasoning[0] = {
              turnId: options.turnId,
              item: { type: "reasoning", id: "page-7-reason-63", summary: [] },
            };
          }
          const data = options.turnId === missingFinalTurnId
            ? Array.from({ length: 64 }, (_, index) => ({
                turnId: options.turnId,
                item: { type: "reasoning", id: `tail-missing-${String(index)}`, summary: [] },
              }))
            : [
                { turnId: options.turnId, item: { type: "agentMessage", id: "tail-final", text: `${options.turnId}:${hugeAnswer}` } },
                { turnId: options.turnId, item: { type: "fileChange", id: "tail-file", status: "completed", changedPaths: [`/workspace/project/src/${options.turnId}.ts`] } },
                { turnId: options.turnId, item: { type: "commandExecution", id: "tail-command", command: "git status", cwd: "/workspace/project", status: "completed", exitCode: 0, durationMs: 5 } },
                ...tailReasoning,
              ];
          return {
            authority: { profileId: authority.id, processGeneration: 1 },
            value: { data, nextCursor: "unread-tail", backwardsCursor: null },
          };
        }
        const pageIndex = options.cursor === undefined || options.cursor === null
          ? 0
          : Number(options.cursor.slice(options.cursor.lastIndexOf("-") + 1));
        const data = pageIndex === 0
          ? [
              { turnId: options.turnId, item: { type: "userMessage", id: "head-user", clientId: `client-${options.turnId}`, text: [`question ${options.turnId}`] } },
              ...Array.from({ length: 63 }, (_, index) => ({
                turnId: options.turnId,
                item: { type: "reasoning", id: `head-reason-${String(index)}`, summary: [] },
              })),
            ]
          : Array.from({ length: 64 }, (_, index) => ({
              turnId: options.turnId,
              item: { type: "reasoning", id: `page-${String(pageIndex)}-reason-${String(index)}`, summary: [] },
            }));
        return {
          authority: { profileId: authority.id, processGeneration: 1 },
          value: {
            data,
            nextCursor: `${options.turnId}-cursor-${String(pageIndex + 1)}`,
            backwardsCursor: null,
          },
        };
      },
      close: async () => undefined,
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      observer: { account: () => undefined, fact: () => undefined },
      launchClient: async () => fake,
    });

    const projection = await manager.readSession({
      authority,
      providerThreadId: "thread-1",
      detail: false,
      signal: new AbortController().signal,
    });

    expect(calls.filter((call) => call.sortDirection === "asc")).toHaveLength(48);
    expect(calls.filter((call) => call.sortDirection === "desc")).toHaveLength(24);
    expect(calls).toHaveLength(72);
    expect(projection.messages?.filter((message) => message.role === "user")).toHaveLength(24);
    expect(projection.messages?.find((message) => message.turnId === "turn-23" && message.role === "assistant")?.text)
      .toStartWith("turn-23:");
    expect(projection.turnSummaries?.find((turn) => turn.id === "turn-23")).toMatchObject({
      files: ["src/turn-23.ts"],
      actions: ["git status"],
    });
    expect(projection.omission?.unreadItemTurnIds).toEqual(chronologicalTurns.map((turn) => turn.id));
    expect(projection.omission?.incompleteTurnIds).toEqual([missingFinalTurnId]);
    expect(projection.omission?.truncatedMessages).toBe(23);
    expect(new TextEncoder().encode(JSON.stringify(projection)).byteLength).toBeLessThanOrEqual(3 * 1024 * 1024);
    await manager.close();
  });

  test("bounds retained provider bytes before projection and reserves the newest tail response", async () => {
    const huge = "\\".repeat(2_000_000);
    const calls: { cursor?: string | null; sortDirection: "asc" | "desc" }[] = [];
    const fake = {
      state: "ready",
      readThread: async () => ({
        authority: { profileId: authority.id, processGeneration: 1 },
        value: makeThread([]),
      }),
      listThreadTurns: async () => ({
        authority: { profileId: authority.id, processGeneration: 1 },
        value: { data: [makeTurn("byte-bounded", [])], nextCursor: null, backwardsCursor: null },
      }),
      listThreadItems: async (options: { cursor?: string | null; sortDirection: "asc" | "desc" }) => {
        calls.push(options);
        if (options.sortDirection === "desc") {
          return {
            authority: { profileId: authority.id, processGeneration: 1 },
            value: {
              data: [
                { turnId: "byte-bounded", item: { type: "agentMessage", id: "final-answer", text: huge } },
                { turnId: "byte-bounded", item: { type: "reasoning", id: "forward-huge-0", summary: [huge] } },
                ...Array.from({ length: 62 }, (_, index) => ({
                  turnId: "byte-bounded",
                  item: { type: "reasoning", id: `tail-huge-${String(index)}`, summary: [huge] },
                })),
              ],
              nextCursor: "unread-tail",
              backwardsCursor: null,
            },
          };
        }
        return {
          authority: { profileId: authority.id, processGeneration: 1 },
          value: {
            data: [
              { turnId: "byte-bounded", item: { type: "userMessage", id: "head-user", clientId: "client-byte", text: ["retain the final answer"] } },
              { turnId: "byte-bounded", item: { type: "reasoning", id: "forward-huge-0", summary: [huge] } },
              { turnId: "byte-bounded", item: { type: "reasoning", id: "forward-huge-1", summary: [huge] } },
            ],
            nextCursor: "page-2-must-not-run",
            backwardsCursor: null,
          },
        };
      },
      close: async () => undefined,
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      observer: { account: () => undefined, fact: () => undefined },
      launchClient: async () => fake,
    });

    const projection = await manager.readSession({
      authority,
      providerThreadId: "thread-1",
      detail: false,
      signal: new AbortController().signal,
    });

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.sortDirection)).toEqual(["asc", "desc"]);
    expect(calls[0]?.cursor).toBeUndefined();
    expect(projection.messages?.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(projection.messages?.at(-1)).toMatchObject({
      role: "assistant",
      turnId: "byte-bounded",
      omission: { originalUtf8Bytes: 2_000_000, returnedUtf8Bytes: 24 * 1024 },
    });
    expect(projection.omission).toMatchObject({
      unreadItemTurnIds: ["byte-bounded"],
      incompleteTurnIds: [],
    });
    expect(new TextEncoder().encode(JSON.stringify(projection)).byteLength).toBeLessThanOrEqual(3 * 1024 * 1024);
    await manager.close();
  });

  test("keeps an older turn's exact head user when a newer huge sibling closes shared retention", async () => {
    const hugeReasoning = "x".repeat(5 * 1024 * 1024);
    const chronologicalTurns = [makeTurn("turn-older", []), makeTurn("turn-later", [])];
    const calls: { cursor?: string | null; sortDirection: "asc" | "desc"; turnId: string }[] = [];
    const fake = {
      state: "ready",
      readThread: async () => ({
        authority: { profileId: authority.id, processGeneration: 1 },
        value: makeThread([]),
      }),
      listThreadTurns: async () => ({
        authority: { profileId: authority.id, processGeneration: 1 },
        value: { data: [...chronologicalTurns].reverse(), nextCursor: null, backwardsCursor: null },
      }),
      listThreadItems: async (options: { cursor?: string | null; sortDirection: "asc" | "desc"; turnId: string }) => {
        calls.push(options);
        if (options.sortDirection === "asc" && options.turnId === "turn-later") {
          return {
            authority: { profileId: authority.id, processGeneration: 1 },
            value: {
              data: [
                { turnId: options.turnId, item: { type: "userMessage", id: "later-head-user", clientId: "later-client", text: ["later question"] } },
                { turnId: options.turnId, item: { type: "reasoning", id: "later-huge-reasoning", summary: [hugeReasoning] } },
              ],
              nextCursor: "later-unread-middle",
              backwardsCursor: null,
            },
          };
        }
        if (options.sortDirection === "asc") {
          return {
            authority: { profileId: authority.id, processGeneration: 1 },
            value: {
              data: [
                { turnId: options.turnId, item: { type: "userMessage", id: "older-head-user", clientId: "original-client", text: ["original question"] } },
                { turnId: options.turnId, item: { type: "reasoning", id: "older-head-reasoning", summary: [] } },
              ],
              nextCursor: "older-unread-middle",
              backwardsCursor: null,
            },
          };
        }
        if (options.turnId === "turn-later") {
          return {
            authority: { profileId: authority.id, processGeneration: 1 },
            value: {
              data: [{ turnId: options.turnId, item: { type: "agentMessage", id: "later-final", text: "later final" } }],
              nextCursor: "later-unread-tail",
              backwardsCursor: null,
            },
          };
        }
        return {
          authority: { profileId: authority.id, processGeneration: 1 },
          value: {
            data: [
              { turnId: options.turnId, item: { type: "agentMessage", id: "older-final", text: "older final" } },
              { turnId: options.turnId, item: { type: "userMessage", id: "older-late-steer", clientId: "late-client", text: ["late steer text"] } },
            ],
            nextCursor: "older-unread-tail",
            backwardsCursor: null,
          },
        };
      },
      close: async () => undefined,
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      observer: { account: () => undefined, fact: () => undefined },
      launchClient: async () => fake,
    });

    const projection = await manager.readSession({
      authority,
      providerThreadId: "thread-1",
      detail: false,
      signal: new AbortController().signal,
    });

    expect(calls.map((call) => `${call.turnId}:${call.sortDirection}`)).toEqual([
      "turn-later:asc",
      "turn-older:asc",
      "turn-later:desc",
      "turn-older:desc",
    ]);
    expect(projection.messages?.filter((message) => message.turnId === "turn-older")).toEqual([
      { role: "user", text: "original question", turnId: "turn-older", clientId: "original-client" },
      { role: "assistant", text: "older final", turnId: "turn-older" },
    ]);
    expect(JSON.stringify(projection)).not.toContain("late steer text");
    expect(projection.omission).toMatchObject({
      unreadItemTurnIds: ["turn-later", "turn-older"],
      incompleteTurnIds: [],
    });
    expect(new TextEncoder().encode(JSON.stringify(projection)).byteLength).toBeLessThanOrEqual(3 * 1024 * 1024);
    await manager.close();
  });

  test("rejects a cyclic recent-item cursor before tail recovery", async () => {
    let page = 0;
    const fake = {
      state: "ready",
      readThread: async () => ({
        authority: { profileId: authority.id, processGeneration: 1 },
        value: makeThread([]),
      }),
      listThreadTurns: async () => ({
        authority: { profileId: authority.id, processGeneration: 1 },
        value: { data: [makeTurn("cyclic", [])], nextCursor: null, backwardsCursor: null },
      }),
      listThreadItems: async () => {
        page += 1;
        return {
          authority: { profileId: authority.id, processGeneration: 1 },
          value: {
            data: [{ turnId: "cyclic", item: { type: "reasoning", id: `reason-${String(page)}`, summary: [] } }],
            nextCursor: "same-cursor",
            backwardsCursor: null,
          },
        };
      },
      close: async () => undefined,
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      observer: { account: () => undefined, fact: () => undefined },
      launchClient: async () => fake,
    });

    await expect(manager.readSession({
      authority,
      providerThreadId: "thread-1",
      detail: false,
      signal: new AbortController().signal,
    })).rejects.toThrow("thread/items/list repeated a cursor in one recent turn");
    expect(page).toBe(2);
    await manager.close();
  });

  test("inspects one exact turn through filtered bounded items without hydrating the thread", async () => {
    const calls: unknown[] = [];
    const target = makeTurn("target", []);
    const fake = {
      state: "ready",
      readThread: async (threadId: string, includeTurns: boolean) => {
        calls.push({ method: "read", threadId, includeTurns });
        return { authority: { profileId: authority.id, processGeneration: 1 }, value: makeThread([]) };
      },
      listThreadTurns: async (options: unknown) => {
        calls.push({ method: "turns", options });
        return { authority: { profileId: authority.id, processGeneration: 1 }, value: { data: [target], nextCursor: null, backwardsCursor: "back" } };
      },
      listThreadItems: async (options: unknown) => {
        calls.push({ method: "items", options });
        return {
          authority: { profileId: authority.id, processGeneration: 1 },
          value: {
            data: [
              { turnId: "target", item: { type: "agentMessage", id: "answer", text: "done" } },
              ...Array.from({ length: 63 }, (_, index) => ({
                turnId: "target",
                item: {
                  type: "userMessage",
                  id: `large-${String(index)}`,
                  clientId: `client-${String(index)}`,
                  text: Array.from({ length: 16 }, () => "\\".repeat(100_000)),
                },
              })),
            ],
            nextCursor: "more-items",
            backwardsCursor: "back",
          },
        };
      },
      close: async () => undefined,
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      observer: { account: () => undefined, fact: () => undefined },
      launchClient: async () => fake,
    });
    const detail = await manager.inspectTurn({ authority, providerThreadId: "thread-1", turnId: "target", signal: new AbortController().signal });
    expect(calls).toContainEqual({ method: "read", threadId: "thread-1", includeTurns: false });
    expect(calls).toContainEqual({ method: "turns", options: { threadId: "thread-1", cursor: null, limit: 128, sortDirection: "desc", itemsView: "notLoaded" } });
    expect(calls).toContainEqual({ method: "items", options: { threadId: "thread-1", turnId: "target", limit: 64, sortDirection: "asc" } });
    const projectedDetail = detail as { id: string; items: unknown[]; omission: { hasMoreItems: boolean; omittedLoadedItems: number } };
    expect(projectedDetail).toMatchObject({ id: "target", omission: { hasMoreItems: true } });
    expect(projectedDetail.items[0]).toMatchObject({ type: "agentMessage", text: "done" });
    expect(projectedDetail.omission.omittedLoadedItems).toBeGreaterThan(0);
    expect(new TextEncoder().encode(JSON.stringify(detail)).byteLength).toBeLessThanOrEqual(3 * 1024 * 1024);
    await manager.close();
  });

  test("inspects one legacy turn through an exact one-turn full compatibility page", async () => {
    const calls: unknown[] = [];
    const newer = makeTurn("newer", []);
    const target = makeTurn("target", []);
    const fullTarget = makeTurn("target", [
      { type: "userMessage", id: "question", clientId: "client", text: ["question"] },
      { type: "agentMessage", id: "answer", text: "answer" },
    ]);
    const fake = {
      state: "ready",
      readThread: async () => ({
        authority: { profileId: authority.id, processGeneration: 1 },
        value: { ...makeThread([]), historyMode: "legacy" as const },
      }),
      listThreadTurns: async (options: { cursor?: string | null; limit: number; itemsView: "notLoaded" | "full" }) => {
        calls.push(options);
        if (options.itemsView === "full") {
          return {
            authority: { profileId: authority.id, processGeneration: 1 },
            value: { data: [fullTarget], nextCursor: null, backwardsCursor: "target-anchor" },
          };
        }
        if (options.limit === 1) {
          return {
            authority: { profileId: authority.id, processGeneration: 1 },
            value: { data: [newer], nextCursor: "before-target", backwardsCursor: "newer-anchor" },
          };
        }
        return {
          authority: { profileId: authority.id, processGeneration: 1 },
          value: { data: [newer, target], nextCursor: null, backwardsCursor: "newer-anchor" },
        };
      },
      listThreadItems: async () => {
        throw new Error("legacy inspection must not request thread/items/list");
      },
      close: async () => undefined,
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      observer: { account: () => undefined, fact: () => undefined },
      launchClient: async () => fake,
    });

    const detail = await manager.inspectTurn({
      authority,
      providerThreadId: "thread-1",
      turnId: "target",
      signal: new AbortController().signal,
    }) as { id: string; items: Array<{ type: string; text?: string }> };
    expect(calls).toEqual([
      { threadId: "thread-1", cursor: null, limit: 128, sortDirection: "desc", itemsView: "notLoaded" },
      { threadId: "thread-1", cursor: null, limit: 1, sortDirection: "desc", itemsView: "notLoaded" },
      { threadId: "thread-1", cursor: "before-target", limit: 1, sortDirection: "desc", itemsView: "full" },
    ]);
    expect(detail.id).toBe("target");
    expect(detail.items.map((item) => item.type)).toEqual(["userMessage", "agentMessage"]);
    await manager.close();
  });

  test("performs a trailing account refresh after overlapping notifications and consumes refresh failure", async () => {
    let onFact: LaunchPinnedCodexOptions["onFact"];
    let refreshCalls = 0;
    let releaseFirst!: () => void;
    const firstRefreshGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let signalTrailing!: () => void;
    const trailingStarted = new Promise<void>((resolve) => { signalTrailing = resolve; });
    const observed: CodexAccountProjection[] = [];
    const fake = {
      state: "ready",
      accountRead: async (refreshToken = false) => {
        if (!refreshToken) {
          return { authority: { profileId: authority.id, processGeneration: 1 }, value: { account: { type: "chatgpt", email: "initial@example.com", planType: "pro" }, requiresOpenaiAuth: true } };
        }
        refreshCalls += 1;
        if (refreshCalls === 1) {
          await firstRefreshGate;
          throw new Error("transient refresh failure");
        }
        signalTrailing();
        return { authority: { profileId: authority.id, processGeneration: 1 }, value: { account: { type: "chatgpt", email: "fresh@example.com", planType: "pro" }, requiresOpenaiAuth: true } };
      },
      close: async () => undefined,
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      observer: { account: (_authority, account) => { observed.push(account); }, fact: () => undefined },
      launchClient: async (options) => {
        onFact = options.onFact;
        return fake;
      },
    });
    await manager.readAccount({ authority, signal: new AbortController().signal });
    const providerAuthority = { profileId: authority.id, processGeneration: 1 };
    await onFact?.({ authority: providerAuthority, value: { type: "accountUpdated", authMode: "chatgpt", planType: "pro" } });
    await Promise.resolve();
    expect(refreshCalls).toBe(1);
    await onFact?.({ authority: providerAuthority, value: { type: "loginCompleted", loginId: "login", success: true } });
    releaseFirst();
    await trailingStarted;
    await manager.close();
    expect(refreshCalls).toBe(2);
    expect(observed).toEqual([]);
  });

  test("forwards failed login completion without scheduling an account refresh", async () => {
    let onFact: LaunchPinnedCodexOptions["onFact"];
    let refreshCalls = 0;
    const observedFacts: CodexFact[] = [];
    const fake = {
      state: "ready",
      accountRead: async (refreshToken = false) => {
        if (refreshToken) refreshCalls += 1;
        return {
          authority: { profileId: authority.id, processGeneration: 1 },
          value: { account: null, requiresOpenaiAuth: true },
        };
      },
      close: async () => undefined,
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      observer: {
        account: () => undefined,
        fact: (_authority, fact) => {
          observedFacts.push(fact);
        },
      },
      launchClient: async (options) => {
        onFact = options.onFact;
        return fake;
      },
    });
    await manager.readAccount({
      authority,
      signal: new AbortController().signal,
    });
    const failed = {
      type: "loginCompleted",
      loginId: "provider-login-timeout",
      success: false,
    } as const;
    await onFact?.({
      authority: { profileId: authority.id, processGeneration: 1 },
      value: failed,
    });
    await manager.close();

    expect(observedFacts).toEqual([failed]);
    expect(refreshCalls).toBe(0);
  });

  test("closes admission before draining in-flight work and discards late facts and account refreshes", async () => {
    let onFact: LaunchPinnedCodexOptions["onFact"];
    let releaseUsage!: () => void;
    let signalUsageStarted!: () => void;
    const usageGate = new Promise<void>((resolve) => { releaseUsage = resolve; });
    const usageStarted = new Promise<void>((resolve) => { signalUsageStarted = resolve; });
    let closeCalls = 0;
    const observedFacts: CodexFact[] = [];
    const observedAccounts: CodexAccountProjection[] = [];
    const providerAuthority = { profileId: authority.id, processGeneration: authority.generation };
    const fake = {
      state: "ready",
      accountRead: async () => ({ authority: providerAuthority, value: { account: { type: "chatgpt", email: "ready@example.com", planType: "pro" }, requiresOpenaiAuth: true } }),
      accountUsage: async () => {
        signalUsageStarted();
        await usageGate;
        return { authority: providerAuthority, value: { summary: { lifetimeTokens: 1, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null }, dailyUsageBuckets: null } };
      },
      accountRateLimits: async () => ({ authority: providerAuthority, value: { primary: { limitId: null, limitName: null, primary: null, secondary: null, planType: null, rateLimitReachedType: null }, byLimitId: null } }),
      close: async () => { closeCalls += 1; },
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      observer: {
        account: (_authority, account) => { observedAccounts.push(account); },
        fact: (_authority, fact) => { observedFacts.push(fact); },
      },
      launchClient: async (options) => {
        onFact = options.onFact;
        return fake;
      },
    });
    await manager.readAccount({ authority, signal: new AbortController().signal });
    const usage = manager.readUsage({ authority, signal: new AbortController().signal });
    await usageStarted;

    const closing = manager.close();
    await expect(manager.readAccount({ authority, signal: new AbortController().signal })).rejects.toThrow("no longer accepts operations");
    await onFact?.({ authority: providerAuthority, value: { type: "accountUpdated", authMode: "chatgpt", planType: "pro" } });
    await Promise.resolve();
    expect(closeCalls).toBe(0);
    expect(observedFacts).toEqual([]);
    expect(observedAccounts).toEqual([]);

    releaseUsage();
    await usage;
    await closing;
    expect(closeCalls).toBe(1);
    await expect(manager.listSessions({ authority, limit: 1, signal: new AbortController().signal })).rejects.toThrow("no longer accepts operations");
  });

  test("joins an owned account refresh that was scheduled before close", async () => {
    let onFact: LaunchPinnedCodexOptions["onFact"];
    let releaseRefresh!: () => void;
    let signalRefreshStarted!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const refreshStarted = new Promise<void>((resolve) => { signalRefreshStarted = resolve; });
    let closeCalls = 0;
    const observed: CodexAccountProjection[] = [];
    const providerAuthority = { profileId: authority.id, processGeneration: authority.generation };
    const fake = {
      state: "ready",
      accountRead: async (refreshToken = false) => {
        if (refreshToken) {
          signalRefreshStarted();
          await refreshGate;
        }
        return { authority: providerAuthority, value: { account: { type: "chatgpt", email: "ready@example.com", planType: "pro" }, requiresOpenaiAuth: true } };
      },
      close: async () => { closeCalls += 1; },
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      observer: { account: (_authority, account) => { observed.push(account); }, fact: () => undefined },
      launchClient: async (options) => {
        onFact = options.onFact;
        return fake;
      },
    });
    await manager.readAccount({ authority, signal: new AbortController().signal });
    await onFact?.({ authority: providerAuthority, value: { type: "accountUpdated", authMode: "chatgpt", planType: "pro" } });
    await refreshStarted;

    let closeSettled = false;
    const closing = manager.close().then(() => { closeSettled = true; });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(closeCalls).toBe(0);
    releaseRefresh();
    await closing;
    expect(closeCalls).toBe(1);
    expect(observed).toEqual([]);
  });
  test("single-flights concurrent first use for one profile generation", async () => {
    let launches = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fake = {
      state: "ready",
      accountUsage: async () => ({ authority: { profileId: authority.id, processGeneration: 1 }, value: { summary: { lifetimeTokens: 1, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null }, dailyUsageBuckets: null } }),
      accountRateLimits: async () => ({ authority: { profileId: authority.id, processGeneration: 1 }, value: { primary: { limitId: null, limitName: null, primary: null, secondary: null, planType: null, rateLimitReachedType: null }, byLimitId: null } }),
      listThreads: async () => ({ authority: { profileId: authority.id, processGeneration: 1 }, value: { data: [], nextCursor: null, backwardsCursor: null } }),
      close: async () => undefined,
    } as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: () => true,
      observer: { account: () => undefined, fact: () => undefined },
      launchClient: async (options: LaunchPinnedCodexOptions) => { void options; launches += 1; await gate; return fake; },
    });
    const usage = manager.readUsage({ authority, signal: new AbortController().signal });
    const sessions = manager.listSessions({ authority, limit: 10, signal: new AbortController().signal });
    await Promise.resolve();
    expect(launches).toBe(1);
    release();
    await Promise.all([usage, sessions]);
    expect(launches).toBe(1);
    await manager.close();
  });

  test("serializes a generation rollover behind one old launch and one new winner", async () => {
    let currentGeneration = 1;
    let launches = 0;
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const closed: number[] = [];
    const makeClient = (generation: number) => ({
      state: "ready",
      accountUsage: async () => ({ authority: { profileId: authority.id, processGeneration: generation }, value: { summary: { lifetimeTokens: generation, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null }, dailyUsageBuckets: null } }),
      accountRateLimits: async () => ({ authority: { profileId: authority.id, processGeneration: generation }, value: { primary: { limitId: null, limitName: null, primary: null, secondary: null, planType: null, rateLimitReachedType: null }, byLimitId: null } }),
      close: async () => { closed.push(generation); },
    }) as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: (candidate) => candidate.generation === currentGeneration,
      observer: { account: () => undefined, fact: () => undefined },
      launchClient: async (options: LaunchPinnedCodexOptions) => {
        launches += 1;
        const generation = options.authority.processGeneration;
        if (generation === 1) await oldGate;
        return makeClient(generation);
      },
    });
    const generationOne = manager.readUsage({ authority, signal: new AbortController().signal });
    await Promise.resolve();
    currentGeneration = 2;
    const nextAuthority = { ...authority, generation: 2 } as const;
    const nextA = manager.readUsage({ authority: nextAuthority, signal: new AbortController().signal });
    const nextB = manager.readUsage({ authority: nextAuthority, signal: new AbortController().signal });
    releaseOld();
    await expect(generationOne).rejects.toThrow("generation changed");
    const [usageA, usageB] = await Promise.all([nextA, nextB]);
    expect(usageA.payload).toEqual(usageB.payload);
    expect(launches).toBe(2);
    expect(closed).toContain(1);
    await manager.close();
  });

  test("closes an established old-generation client before launching its replacement", async () => {
    let currentGeneration = 1;
    const closed: number[] = [];
    const observedFacts: Array<Readonly<{
      authority: ProfileAuthority;
      fact: CodexFact;
    }>> = [];
    const makeClient = (generation: number) => ({
      state: "ready",
      connectionId: `connection-${generation}`,
      accountUsage: async () => ({ authority: { profileId: authority.id, processGeneration: generation }, value: { summary: { lifetimeTokens: generation, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null }, dailyUsageBuckets: null } }),
      accountRateLimits: async () => ({ authority: { profileId: authority.id, processGeneration: generation }, value: { primary: { limitId: null, limitName: null, primary: null, secondary: null, planType: null, rateLimitReachedType: null }, byLimitId: null } }),
      close: async () => { closed.push(generation); },
    }) as unknown as CodexAppServerClient;
    const manager = createRuntimeManager({
      isCurrent: (candidate) => candidate.generation === currentGeneration,
      observer: {
        account: () => undefined,
        fact: (observedAuthority, fact) => {
          observedFacts.push({ authority: observedAuthority, fact });
        },
      },
      launchClient: async (options: LaunchPinnedCodexOptions) =>
        makeClient(options.authority.processGeneration),
    });

    await manager.readUsage({ authority, signal: new AbortController().signal });
    currentGeneration = 2;
    const replacementAuthority = { ...authority, generation: 2 } as const;
    const replacementUsage = await manager.readUsage({
      authority: replacementAuthority,
      signal: new AbortController().signal,
    });

    expect(replacementUsage.payload).toMatchObject({
      usage: { summary: { lifetimeTokens: 2 } },
    });
    expect(closed).toEqual([1]);
    expect(observedFacts).toEqual([]);
    await manager.close();
  });
});
